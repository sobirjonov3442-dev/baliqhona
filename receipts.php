<?php
/**
 * GET /api/receipts — Barcha cheklarni olish
 * POST /api/receipts — Yangi chek yaratish
 */

$db = getDB();

if ($method === 'GET') {
    $receipts = fetchAll($db, 'SELECT * FROM receipts ORDER BY id DESC');
    $db->close();
    jsonResponse($receipts);
    
} elseif ($method === 'POST') {
    $data = getRequestBody();
    
    $timestamp = date('c');
    $itemsJson = json_encode($data['items'] ?? [], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    
    executeQuery($db, 'INSERT INTO receipts ("table", items, total, service_charge, cash_given, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
        [
            $data['table'] ?? '',
            $itemsJson,
            $data['total'] ?? 0,
            $data['service_charge'] ?? 0,
            $data['cash_given'] ?? 0,
            $timestamp
        ]);
    
    // Archive orders for this table
    executeQuery($db, 'UPDATE orders SET status = \'archived\' WHERE "table" = ? AND status != \'cancelled\' AND status != \'archived\'',
        [$data['table'] ?? '']);
    
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'DELETE' && $id !== null) {
    executeQuery($db, 'DELETE FROM receipts WHERE CAST(id AS TEXT) = ?', [strval($id)]);
    $db->close();
    jsonResponse(['success' => true]);
    
} elseif ($method === 'DELETE' && $id === null) {
    executeQuery($db, 'DELETE FROM receipts');
    $db->close();
    jsonResponse(['success' => true]);
    
} else {
    $db->close();
    jsonResponse(['error' => 'Method not allowed'], 405);
}
