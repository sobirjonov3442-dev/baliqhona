<?php
/**
 * POST /api/menus — Menyu qo'shish/yangilash
 * DELETE /api/menus/{id} — Menyu o'chirish
 * PUT /api/menus/{id}/toggle — Menyu faolligini o'zgartirish
 * PUT /api/menus/{id}/stock — Menyu miqdorini oshirish
 */

$db = getDB();

if ($method === 'POST' && $id === null) {
    $data = getRequestBody();
    
    $existing = fetchOne($db, "SELECT id FROM menu WHERE CAST(id AS TEXT)=?", [strval($data['id'])]);
    
    if ($existing) {
        executeQuery($db, "UPDATE menu SET icon=?, name=?, category=?, price=?, unit=?, quantity=?, weight_per_piece=?, active=? WHERE CAST(id AS TEXT)=?",
            [
                $data['icon'],
                $data['name'],
                $data['category'],
                $data['price'],
                $data['unit'] ?? 'dona',
                $data['quantity'] ?? 0,
                $data['weight_per_piece'] ?? 1,
                $data['active'] ?? 1,
                strval($data['id'])
            ]);

        // Auto calculate related products' prices if unit is 'kg'
        if (isset($data['unit']) && $data['unit'] === 'kg' && isset($data['weight_per_piece']) && floatval($data['weight_per_piece']) > 0) {
            $updatedPrice = floatval($data['price']);
            $weight = floatval($data['weight_per_piece']);
            $basePricePerKg = $updatedPrice / $weight;
            
            $baseName = trim(preg_replace('/\s+[\d\.]+\s*kg\s*$/i', '', $data['name']));
            $likeName = $baseName . ' %kg%';
            
            executeQuery($db, "UPDATE menu SET price = ROUND(weight_per_piece * ?) WHERE name LIKE ? AND unit = 'kg' AND CAST(id AS TEXT) != ?", 
                [$basePricePerKg, $likeName, strval($data['id'])]
            );
        }
    } else {
        executeQuery($db, "INSERT INTO menu (id, icon, name, category, price, unit, quantity, weight_per_piece, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                $data['id'],
                $data['icon'],
                $data['name'],
                $data['category'],
                $data['price'],
                $data['unit'] ?? 'dona',
                $data['quantity'] ?? 0,
                $data['weight_per_piece'] ?? 1,
                $data['active'] ?? 1
            ]);
    }
    
    // Inventory kirim qilish
    $invQty = floatval($data['inventory_quantity'] ?? 0);
    if ($invQty > 0) {
        $existingInv = fetchOne($db, "SELECT id FROM inventory WHERE name=?", [$data['name']]);
        if ($existingInv) {
            executeQuery($db, "UPDATE inventory SET quantity = quantity + ? WHERE id=?", [$invQty, $existingInv['id']]);
        } else {
            executeQuery($db, "INSERT INTO inventory (name, unit, quantity, created_at) VALUES (?, ?, ?, ?)", 
                [$data['name'], $data['unit'] ?? 'dona', $invQty, date('Y-m-d H:i:s')]);
        }
    }

    // Ingredientlarni saqlash (agar bor bo'lsa)
    $menuId = $data['id'];
    if (isset($data['ingredients']) && is_array($data['ingredients'])) {
        // Eski ingredientlarni o'chirish
        executeQuery($db, "DELETE FROM menu_ingredients WHERE menu_id = ?", [intval($menuId)]);
        
        // Yangilarini qo'shish
        foreach ($data['ingredients'] as $ing) {
            if (!empty($ing['inventory_id']) && floatval($ing['quantity']) > 0) {
                executeQuery($db, 
                    "INSERT INTO menu_ingredients (menu_id, inventory_id, quantity, unit) VALUES (?, ?, ?, ?)",
                    [intval($menuId), intval($ing['inventory_id']), floatval($ing['quantity']), $ing['unit'] ?? 'kg']);
            }
        }
    }
    
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'PUT' && $id !== null && $action === 'toggle') {
    executeQuery($db, "UPDATE menu SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE CAST(id AS TEXT)=?", [strval($id)]);
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'PUT' && $id !== null && $action === 'stock') {
    $data = getRequestBody();
    $addQty = floatval($data['quantity'] ?? 0);
    executeQuery($db, "UPDATE menu SET quantity = quantity + ? WHERE CAST(id AS TEXT)=?", [$addQty, strval($id)]);
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'DELETE' && $id !== null) {
    executeQuery($db, "DELETE FROM menu WHERE CAST(id AS TEXT)=?", [strval($id)]);
    $db->close();
    jsonResponse(['success' => true]);
    
} else {
    $db->close();
    jsonResponse(['error' => 'Method not allowed'], 405);
}
