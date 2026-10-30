<?php
/**
 * POST /api/orders — Yangi buyurtma yaratish
 * PUT /api/orders/{id}/status — Buyurtma statusini o'zgartirish
 * PUT /api/orders/{id}/receipt — Receipt printed belgilash
 * DELETE /api/orders/{id} — Buyurtma o'chirish
 */

$db = getDB();

if ($method === 'POST' && $id === null) {
    $data = getRequestBody();
    
    $db->exec('BEGIN TRANSACTION');
    try {
        executeQuery($db, 'INSERT INTO orders (id, "table", peopleCount, items, total, status, waiterId, chefId, timestamp, customerName) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            $data['id'],
            $data['table'],
            $data['peopleCount'],
            json_encode($data['items'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            $data['total'],
            $data['status'],
            $data['waiterId'],
            $data['chefId'] ?? null,
            $data['timestamp'],
            $data['customerName'] ?? ''
        ]);
    
    // Ombordan avtomatik ayirish (menu_ingredients orqali)
    // Ombordan avtomatik ayirish (menu_ingredients orqali) - N+1 Optimizatsiya
    $menuDeducts = [];
    $itemIds = [];

    foreach ($data['items'] as $item) {
        $itemId = $item['menuId'] ?? $item['id'];
        if (!is_numeric($itemId)) continue;
        $itemId = intval($itemId);
        $qty = intval($item['qty']);
        
        $qtyToDeduct = (($item['unit'] ?? '') === 'kg') ? floatval($item['kg'] ?? 0) * $qty : $qty;
        
        if (!isset($menuDeducts[$itemId])) $menuDeducts[$itemId] = 0;
        $menuDeducts[$itemId] += $qtyToDeduct;
        
        if (!in_array($itemId, $itemIds)) $itemIds[] = $itemId;
    }

    if (!empty($itemIds)) {
        // 1. Menu update
        $stmtMenu = $db->prepare("UPDATE menu SET quantity = quantity - ? WHERE CAST(id AS TEXT) = ?");
        foreach ($menuDeducts as $iId => $deduct) {
            $stmtMenu->bindValue(1, $deduct);
            $stmtMenu->bindValue(2, strval($iId));
            $stmtMenu->execute();
        }
        
        // 2. Fetch all ingredients in ONE query
        $placeholders = implode(',', array_fill(0, count($itemIds), '?'));
        $ingredients = fetchAll($db, "SELECT * FROM menu_ingredients WHERE menu_id IN ($placeholders)", $itemIds);
        
        $menuHasIngredients = [];
        foreach ($ingredients as $ing) {
            $menuHasIngredients[intval($ing['menu_id'])] = true;
        }
        
        // 3. Aggregate inventory deductions
        $invDeducts = [];
        foreach ($ingredients as $ing) {
            $mId = intval($ing['menu_id']);
            $invId = intval($ing['inventory_id']);
            $ingQty = floatval($ing['quantity']);
            
            // Masalliq miqdori = (1 porsiya masalliq) * (nechta porsiya ovqat)
            $totalDeduct = $ingQty * $menuDeducts[$mId];
            
            if (!isset($invDeducts[$invId])) $invDeducts[$invId] = 0;
            $invDeducts[$invId] += $totalDeduct;
        }
        
        // AUTO-FALLBACK: For items with NO ingredients, try to deduct by matching name
        foreach ($data['items'] as $item) {
            $itemId = intval($item['menuId'] ?? $item['id']);
            if (!isset($menuHasIngredients[$itemId])) {
                // Fetch inventory item with exact same name
                $invMatch = fetchOne($db, "SELECT id FROM inventory WHERE name = ?", [$item['name']]);
                if ($invMatch) {
                    $invId = intval($invMatch['id']);
                    $qtyToDeduct = (($item['unit'] ?? '') === 'kg') ? floatval($item['kg'] ?? 0) * intval($item['qty']) : intval($item['qty']);
                    
                    if (!isset($invDeducts[$invId])) $invDeducts[$invId] = 0;
                    $invDeducts[$invId] += $qtyToDeduct;
                }
            }
        }
        
        if (!empty($invDeducts)) {
            $invIds = array_keys($invDeducts);
            $placeholdersInv = implode(',', array_fill(0, count($invIds), '?'));
            $invItems = fetchAll($db, "SELECT * FROM inventory WHERE id IN ($placeholdersInv)", $invIds);
            
            $invItemsMap = [];
            foreach ($invItems as $invItem) {
                $invItemsMap[intval($invItem['id'])] = $invItem;
            }
            
            $stmtInv = $db->prepare("UPDATE inventory SET quantity = quantity - ?, updated_at = ? WHERE id = ?");
            $stmtNotif = $db->prepare("INSERT INTO notifications (id, userId, message, type, read, timestamp) VALUES (?, ?, ?, ?, ?, ?)");
            $currentTime = date('c');
            
            foreach ($invDeducts as $invId => $totalDeduct) {
                $stmtInv->bindValue(1, $totalDeduct);
                $stmtInv->bindValue(2, $currentTime);
                $stmtInv->bindValue(3, $invId);
                $stmtInv->execute();
                
                if (isset($invItemsMap[$invId])) {
                    $invItem = $invItemsMap[$invId];
                    $currentQty = floatval($invItem['quantity']);
                    $newQty = $currentQty - $totalDeduct;
                    $minAlert = floatval($invItem['min_alert'] ?? 0);
                    
                    if (($currentQty > $minAlert && $newQty <= $minAlert) || ($currentQty > 0 && $newQty <= 0)) {
                        $notifId = time() . rand(100, 9999);
                        $notifMsg = "⚠️ DIQQAT: \"{$invItem['name']}\" kam qoldi (buyurtma sababli)! Qoldiq: {$newQty} {$invItem['unit']}.";
                        
                        $stmtNotif->bindValue(1, $notifId);
                        $stmtNotif->bindValue(2, '1'); // admin id
                        $stmtNotif->bindValue(3, $notifMsg);
                        $stmtNotif->bindValue(4, 'low_stock');
                        $stmtNotif->bindValue(5, 0);
                        $stmtNotif->bindValue(6, $currentTime);
                        $stmtNotif->execute();
                    }
                }
            }
        }
    }
    
    $db->exec('COMMIT');
    $db->close();
    jsonResponse(['success' => true]);
    
    } catch (Exception $e) {
        $db->exec('ROLLBACK');
        $db->close();
        jsonResponse(['error' => 'Database error', 'message' => $e->getMessage()], 500);
    }
} elseif ($method === 'PUT' && $id !== null && $action === 'edit') {
    $data = getRequestBody();
    
    $db->exec('BEGIN TRANSACTION');
    try {
        $oldOrder = fetchOne($db, 'SELECT * FROM orders WHERE CAST(id AS TEXT)=?', [strval($id)]);
        if (!$oldOrder) {
            throw new Exception("Order not found");
        }
        
        $oldItems = json_decode($oldOrder['items'], true);
        if (!is_array($oldItems)) $oldItems = [];
        
        // --- 1. RESTOCK OLD ITEMS ---
        $menuRestocks = [];
        $oldItemIds = [];
        foreach ($oldItems as $item) {
            $itemId = $item['menuId'] ?? $item['id'];
            if (!is_numeric($itemId)) continue;
            $itemId = intval($itemId);
            $qty = intval($item['qty']);
            $qtyToRestock = (($item['unit'] ?? '') === 'kg') ? floatval($item['kg'] ?? 0) * $qty : $qty;
            
            if (!isset($menuRestocks[$itemId])) $menuRestocks[$itemId] = 0;
            $menuRestocks[$itemId] += $qtyToRestock;
            if (!in_array($itemId, $oldItemIds)) $oldItemIds[] = $itemId;
        }

        if (!empty($oldItemIds)) {
            $stmtMenu = $db->prepare("UPDATE menu SET quantity = quantity + ? WHERE CAST(id AS TEXT) = ?");
            foreach ($menuRestocks as $iId => $restock) {
                $stmtMenu->bindValue(1, $restock);
                $stmtMenu->bindValue(2, strval($iId));
                $stmtMenu->execute();
            }
            
            $placeholders = implode(',', array_fill(0, count($oldItemIds), '?'));
            $ingredients = fetchAll($db, "SELECT * FROM menu_ingredients WHERE menu_id IN ($placeholders)", $oldItemIds);
            
            $menuHasIngredients = [];
            foreach ($ingredients as $ing) {
                $menuHasIngredients[intval($ing['menu_id'])] = true;
            }
            
            $invRestocks = [];
            foreach ($ingredients as $ing) {
                $mId = intval($ing['menu_id']);
                $invId = intval($ing['inventory_id']);
                $ingQty = floatval($ing['quantity']);
                $totalRestock = $ingQty * $menuRestocks[$mId];
                
                if (!isset($invRestocks[$invId])) $invRestocks[$invId] = 0;
                $invRestocks[$invId] += $totalRestock;
            }
            
            foreach ($oldItems as $item) {
                $itemId = intval($item['menuId'] ?? $item['id']);
                if (!isset($menuHasIngredients[$itemId])) {
                    $invMatch = fetchOne($db, "SELECT id FROM inventory WHERE name = ?", [$item['name']]);
                    if ($invMatch) {
                        $invId = intval($invMatch['id']);
                        $qtyToRestock = (($item['unit'] ?? '') === 'kg') ? floatval($item['kg'] ?? 0) * intval($item['qty']) : intval($item['qty']);
                        if (!isset($invRestocks[$invId])) $invRestocks[$invId] = 0;
                        $invRestocks[$invId] += $qtyToRestock;
                    }
                }
            }
            
            if (!empty($invRestocks)) {
                $stmtInv = $db->prepare("UPDATE inventory SET quantity = quantity + ? WHERE id = ?");
                foreach ($invRestocks as $invId => $totalRestock) {
                    $stmtInv->bindValue(1, $totalRestock);
                    $stmtInv->bindValue(2, $invId);
                    $stmtInv->execute();
                }
            }
        }

        // --- 2. DEDUCT NEW ITEMS ---
        $newItems = $data['items'];
        $menuDeducts = [];
        $newItemIds = [];
        foreach ($newItems as $item) {
            $itemId = $item['menuId'] ?? $item['id'];
            if (!is_numeric($itemId)) continue;
            $itemId = intval($itemId);
            $qty = intval($item['qty']);
            $qtyToDeduct = (($item['unit'] ?? '') === 'kg') ? floatval($item['kg'] ?? 0) * $qty : $qty;
            
            if (!isset($menuDeducts[$itemId])) $menuDeducts[$itemId] = 0;
            $menuDeducts[$itemId] += $qtyToDeduct;
            if (!in_array($itemId, $newItemIds)) $newItemIds[] = $itemId;
        }

        if (!empty($newItemIds)) {
            $stmtMenu = $db->prepare("UPDATE menu SET quantity = quantity - ? WHERE CAST(id AS TEXT) = ?");
            foreach ($menuDeducts as $iId => $deduct) {
                $stmtMenu->bindValue(1, $deduct);
                $stmtMenu->bindValue(2, strval($iId));
                $stmtMenu->execute();
            }
            
            $placeholders = implode(',', array_fill(0, count($newItemIds), '?'));
            $ingredients = fetchAll($db, "SELECT * FROM menu_ingredients WHERE menu_id IN ($placeholders)", $newItemIds);
            
            $menuHasIngredients = [];
            foreach ($ingredients as $ing) {
                $menuHasIngredients[intval($ing['menu_id'])] = true;
            }
            
            $invDeducts = [];
            foreach ($ingredients as $ing) {
                $mId = intval($ing['menu_id']);
                $invId = intval($ing['inventory_id']);
                $ingQty = floatval($ing['quantity']);
                $totalDeduct = $ingQty * $menuDeducts[$mId];
                
                if (!isset($invDeducts[$invId])) $invDeducts[$invId] = 0;
                $invDeducts[$invId] += $totalDeduct;
            }
            
            foreach ($newItems as $item) {
                $itemId = intval($item['menuId'] ?? $item['id']);
                if (!isset($menuHasIngredients[$itemId])) {
                    $invMatch = fetchOne($db, "SELECT id FROM inventory WHERE name = ?", [$item['name']]);
                    if ($invMatch) {
                        $invId = intval($invMatch['id']);
                        $qtyToDeduct = (($item['unit'] ?? '') === 'kg') ? floatval($item['kg'] ?? 0) * intval($item['qty']) : intval($item['qty']);
                        if (!isset($invDeducts[$invId])) $invDeducts[$invId] = 0;
                        $invDeducts[$invId] += $qtyToDeduct;
                    }
                }
            }
            
            if (!empty($invDeducts)) {
                $currentTime = date('c');
                $stmtInv = $db->prepare("UPDATE inventory SET quantity = quantity - ?, updated_at = ? WHERE id = ?");
                foreach ($invDeducts as $invId => $totalDeduct) {
                    $stmtInv->bindValue(1, $totalDeduct);
                    $stmtInv->bindValue(2, $currentTime);
                    $stmtInv->bindValue(3, $invId);
                    $stmtInv->execute();
                }
            }
        }
        
        // --- 3. UPDATE ORDER ---
        $itemsJson = json_encode($newItems, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        executeQuery($db, "UPDATE orders SET items=?, total=? WHERE CAST(id AS TEXT)=?", [
            $itemsJson,
            $data['total'],
            strval($id)
        ]);
        
        $db->exec('COMMIT');
        $db->close();
        jsonResponse(['success' => true]);
        
    } catch (Exception $e) {
        $db->exec('ROLLBACK');
        $db->close();
        jsonResponse(['error' => 'Database error', 'message' => $e->getMessage()], 500);
    }
} elseif ($method === 'PUT' && $id !== null && $action === 'status') {
    $data = getRequestBody();
    $newStatus = $data['status'];
    $chefId = $data['chefId'] ?? null;
    
    // Get current order
    $order = fetchOne($db, 'SELECT * FROM orders WHERE CAST(id AS TEXT)=?', [strval($id)]);
    
    $query = 'UPDATE orders SET status=?';
    $params = [$newStatus];
    
    if ($chefId !== null) {
        $query .= ', chefId=?';
        $params[] = $chefId;
    }
    
    if ($newStatus === 'ready' && $order) {
        $completedAt = date('c') . 'Z';
        $query .= ', completedAt=?';
        $params[] = $completedAt;
        
        // Check if Saboy order
        if (strpos($order['table'], 'Saboy-') === 0) {
            $saboyNum = explode('-', $order['table'])[1];
            executeQuery($db, "INSERT INTO notifications (userId, message, type, read, timestamp, orderId) VALUES (?, ?, ?, ?, ?, ?)",
                [$order['waiterId'], "Saboy tayyor, raqam $saboyNum", 'saboy_ready', 0, $completedAt, strval($id)]);
        }
    }
    
    $query .= ' WHERE CAST(id AS TEXT)=?';
    $params[] = strval($id);
    
    executeQuery($db, $query, $params);
    
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'PUT' && $id !== null && $action === 'receipt') {
    $order = fetchOne($db, "SELECT * FROM orders WHERE CAST(id AS TEXT)=?", [strval($id)]);
    if ($order && strpos($order['table'], 'Saboy-') === 0) {
        executeQuery($db, "UPDATE orders SET receiptPrinted = 1, status = 'archived' WHERE CAST(id AS TEXT)=?", [strval($id)]);
    } else {
        executeQuery($db, "UPDATE orders SET receiptPrinted = 1 WHERE CAST(id AS TEXT)=?", [strval($id)]);
    }
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'PUT' && $id !== null && $action === 'deliver') {
    $data = getRequestBody();
    $deliveredBy = $data['deliveredBy'] ?? '';
    $newStatus = $data['status'] ?? 'delivering';
    
    $query = 'UPDATE orders SET deliveredBy=?, status=? WHERE CAST(id AS TEXT)=?';
    $params = [$deliveredBy, $newStatus, strval($id)];
    
    executeQuery($db, $query, $params);
    
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'PUT' && $id !== null && $action === 'table') {
    $data = getRequestBody();
    $newTable = $data['table'] ?? '';
    
    $query = 'UPDATE orders SET "table"=? WHERE CAST(id AS TEXT)=?';
    $params = [$newTable, strval($id)];
    
    executeQuery($db, $query, $params);
    
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'DELETE' && $id !== null) {
    executeQuery($db, 'DELETE FROM orders WHERE CAST(id AS TEXT) = ?', [strval($id)]);
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'DELETE' && $id === null) {
    executeQuery($db, 'DELETE FROM orders');
    $db->close();
    jsonResponse(['success' => true]);
    
} else {
    $db->close();
    jsonResponse(['error' => 'Method not allowed'], 405);
}
