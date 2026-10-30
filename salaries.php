<?php
/**
 * POST /api/salaries — Oylik saqlash
 */

$db = getDB();

if ($method === 'POST') {
    $data = getRequestBody();
    
    executeQuery($db, "INSERT INTO salaries (id, userId, amount, percentage, date, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        [$data['id'], $data['userId'], $data['amount'], $data['percentage'], $data['date'], $data['timestamp']]);
    
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'DELETE' && $id !== null) {
    executeQuery($db, 'DELETE FROM salaries WHERE CAST(id AS TEXT) = ?', [strval($id)]);
    $db->close();
    jsonResponse(['success' => true]);
    
} else {
    $db->close();
    jsonResponse(['error' => 'Method not allowed'], 405);
}
