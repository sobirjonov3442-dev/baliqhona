<?php
/**
 * POST /api/users — Foydalanuvchi qo'shish/yangilash
 * DELETE /api/users/{id} — Foydalanuvchi o'chirish
 */

$db = getDB();

if ($method === 'POST') {
    $data = getRequestBody();
    
    $existing = fetchOne($db, "SELECT id FROM users WHERE CAST(id AS TEXT)=?", [strval($data['id'])]);
    
    if ($existing) {
        executeQuery($db, "UPDATE users SET role=?, name=?, phone=?, login=?, password=? WHERE CAST(id AS TEXT)=?",
            [$data['role'], $data['name'], $data['phone'], $data['login'], $data['password'], strval($data['id'])]);
    } else {
        executeQuery($db, "INSERT INTO users (id, role, name, phone, login, password) VALUES (?, ?, ?, ?, ?, ?)",
            [$data['id'], $data['role'], $data['name'], $data['phone'], $data['login'], $data['password']]);
    }
    
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'DELETE' && $id !== null) {
    executeQuery($db, "DELETE FROM users WHERE CAST(id AS TEXT)=?", [strval($id)]);
    $db->close();
    jsonResponse(['success' => true]);
    
} else {
    $db->close();
    jsonResponse(['error' => 'Method not allowed'], 405);
}
