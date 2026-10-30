<?php
/**
 * GET /api/inventory — Barcha ombor mahsulotlarini olish
 * POST /api/inventory — Yangi mahsulot qo'shish
 * PUT /api/inventory/{id} — Mahsulotni tahrirlash
 * PUT /api/inventory/{id}/stock — Miqdor qo'shish (yangi kelgan tovar)
 * PUT /api/inventory/{id}/deduct — Miqdor ayirish (oshpaz sotib olganda)
 * DELETE /api/inventory/{id} — Mahsulotni o'chirish
 */

$db = getDB();

if ($method === 'GET' && $id === null) {
    // Barcha ombor mahsulotlarini olish
    $items = fetchAll($db, "SELECT * FROM inventory ORDER BY name ASC");
    
    // Barcha bog'lanishlarni bitta so'rovda olish (N+1 muammosini oldini olish)
    $allLinksRaw = fetchAll($db, 
        "SELECT mi.inventory_id, mi.quantity as ingredient_qty, mi.unit as ingredient_unit, m.name as menu_name, m.id as menu_id 
         FROM menu_ingredients mi 
         JOIN menu m ON mi.menu_id = m.id");
         
    $linksMap = [];
    foreach ($allLinksRaw as $link) {
        $invId = $link['inventory_id'];
        if (!isset($linksMap[$invId])) {
            $linksMap[$invId] = [];
        }
        $linksMap[$invId][] = $link;
    }
    
    // Har bir mahsulot uchun qaysi menularga bog'langanligini ham olish
    foreach ($items as &$item) {
        $item['linked_menus'] = isset($linksMap[$item['id']]) ? $linksMap[$item['id']] : [];
    }
    
    $db->close();
    jsonResponse($items);

} elseif ($method === 'POST' && $id === null) {
    // Yangi mahsulot qo'shish
    $data = getRequestBody();
    
    $now = date('c');
    executeQuery($db, 
        "INSERT INTO inventory (name, unit, quantity, price, min_alert, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            $data['name'],
            $data['unit'] ?? 'kg',
            floatval($data['quantity'] ?? 0),
            floatval($data['price'] ?? 0),
            floatval($data['min_alert'] ?? 0),
            $data['icon'] ?? '',
            $now,
            $now
        ]);
    
    $newId = $db->lastInsertRowID();
    $db->close();
    jsonResponse(['success' => true, 'id' => $newId]);

} elseif ($method === 'PUT' && $id !== null && $action === 'stock') {
    // Miqdor qo'shish (yangi kelgan tovar)
    $data = getRequestBody();
    $addQty = floatval($data['quantity'] ?? 0);
    
    executeQuery($db, "UPDATE inventory SET quantity = quantity + ?, updated_at = ? WHERE id = ?", 
        [$addQty, date('c'), intval($id)]);
    
    $db->close();
    jsonResponse(['success' => true]);

} elseif ($method === 'PUT' && $id !== null && $action === 'deduct') {
    // Oshpaz magazindan sotib olish — miqdorni ayirish
    $data = getRequestBody();
    $deductQty = floatval($data['quantity'] ?? 0);
    $chefName = $data['chef_name'] ?? 'Oshpaz';
    
    if ($deductQty <= 0) {
        $db->close();
        jsonResponse(['error' => 'Noto\'g\'ri miqdor'], 400);
    }
    
    // Avval mahsulotni tekshirish
    $item = fetchOne($db, "SELECT * FROM inventory WHERE id = ?", [intval($id)]);
    
    if (!$item) {
        $db->close();
        jsonResponse(['error' => 'Mahsulot topilmadi'], 404);
    }
    
    $currentQty = floatval($item['quantity']);
    
    if ($currentQty < $deductQty) {
        $db->close();
        jsonResponse([
            'error' => 'Yetarli mahsulot yo\'q!',
            'available' => $currentQty,
            'requested' => $deductQty,
            'unit' => $item['unit']
        ], 400);
    }
    
    // Miqdorni ayirish
    $newQty = $currentQty - $deductQty;
    executeQuery($db, "UPDATE inventory SET quantity = ?, updated_at = ? WHERE id = ?", 
        [$newQty, date('c'), intval($id)]);
    
    // Agar min_alert dan past bo'lsa — adminga bildirishnoma yuborish
    $minAlert = floatval($item['min_alert'] ?? 0);
    if ($minAlert > 0 && $newQty <= $minAlert) {
        $notifId = time() . rand(100, 999);
        $notifMsg = "⚠️ DIQQAT: \"{$item['name']}\" kam qoldi! Qoldiq: {$newQty} {$item['unit']} (Min: {$minAlert} {$item['unit']}). {$chefName} {$deductQty} {$item['unit']} oldi.";
        executeQuery($db, 
            "INSERT INTO notifications (id, userId, message, type, read, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            [$notifId, '1', $notifMsg, 'low_stock', 0, date('c')]
        );
    }
    
    $db->close();
    jsonResponse([
        'success' => true, 
        'new_quantity' => $newQty,
        'item_name' => $item['name'],
        'deducted' => $deductQty,
        'low_stock' => ($minAlert > 0 && $newQty <= $minAlert)
    ]);

} elseif ($method === 'PUT' && $id !== null && $action === null) {
    // Mahsulotni tahrirlash
    $data = getRequestBody();
    
    $fields = [];
    $params = [];
    
    if (isset($data['name'])) { $fields[] = 'name = ?'; $params[] = $data['name']; }
    if (isset($data['unit'])) { $fields[] = 'unit = ?'; $params[] = $data['unit']; }
    if (isset($data['quantity'])) { $fields[] = 'quantity = ?'; $params[] = floatval($data['quantity']); }
    if (isset($data['price'])) { $fields[] = 'price = ?'; $params[] = floatval($data['price']); }
    if (isset($data['min_alert'])) { $fields[] = 'min_alert = ?'; $params[] = floatval($data['min_alert']); }
    if (isset($data['icon'])) { $fields[] = 'icon = ?'; $params[] = $data['icon']; }
    
    $fields[] = 'updated_at = ?';
    $params[] = date('c');
    $params[] = intval($id);
    
    executeQuery($db, "UPDATE inventory SET " . implode(', ', $fields) . " WHERE id = ?", $params);
    
    $db->close();
    jsonResponse(['success' => true]);

} elseif ($method === 'DELETE' && $id !== null) {
    // Mahsulotni o'chirish (avval bog'lanishlarini ham o'chirish)
    executeQuery($db, "DELETE FROM menu_ingredients WHERE inventory_id = ?", [intval($id)]);
    executeQuery($db, "DELETE FROM inventory WHERE id = ?", [intval($id)]);
    
    $db->close();
    jsonResponse(['success' => true]);

} else {
    $db->close();
    jsonResponse(['error' => 'Method not allowed'], 405);
}
