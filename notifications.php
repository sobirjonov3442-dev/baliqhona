<?php
/**
 * POST /api/notifications — Bildirishnoma qo'shish
 * PUT /api/notifications/read — Barcha bildirishnomalarni o'qilgan deb belgilash
 */

$db = getDB();

if ($method === 'POST') {
    $data = getRequestBody();
    
    executeQuery($db, "INSERT INTO notifications (id, userId, message, type, read, timestamp, orderId) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [$data['id'], $data['userId'], $data['message'], $data['type'], intval($data['read'] ?? false), $data['timestamp'], $data['orderId'] ?? null]);
    
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'PUT' && $id === 'read') {
    $data = getRequestBody();
    $userId = $data['userId'];
    
    executeQuery($db, "UPDATE notifications SET read=1 WHERE userId=?", [$userId]);
    
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'DELETE' && $id !== null) {
    executeQuery($db, "DELETE FROM notifications WHERE id=?", [$id]);
    
    $db->close();
    jsonResponse(['success' => true]);
    
} else {
    $db->close();
    jsonResponse(['error' => 'Method not allowed'], 405);
}
