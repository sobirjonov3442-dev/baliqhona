<?php
/**
 * POST /api/categories — Kategoriya qo'shish/yangilash
 * DELETE /api/categories/{id} — Kategoriya o'chirish
 */

$db = getDB();

if ($method === 'POST') {
    $data = getRequestBody();
    
    $existing = fetchOne($db, "SELECT id FROM categories WHERE CAST(id AS TEXT)=?", [strval($data['id'])]);
    
    if ($existing) {
        executeQuery($db, "UPDATE categories SET name=?, value=? WHERE CAST(id AS TEXT)=?",
            [$data['name'], $data['value'], strval($data['id'])]);
    } else {
        executeQuery($db, "INSERT INTO categories (id, name, value) VALUES (?, ?, ?)",
            [$data['id'], $data['name'], $data['value']]);
    }
    
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'DELETE' && $id !== null) {
    executeQuery($db, "DELETE FROM categories WHERE CAST(id AS TEXT)=?", [strval($id)]);
    $db->close();
    jsonResponse(['success' => true]);
    
} else {
    $db->close();
    jsonResponse(['error' => 'Method not allowed'], 405);
}
