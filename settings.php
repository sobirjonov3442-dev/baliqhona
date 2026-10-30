<?php
/**
 * POST /api/settings — Sozlamalarni saqlash
 */

$db = getDB();

if ($method === 'POST') {
    $data = getRequestBody();
    
    foreach ($data as $key => $value) {
        executeQuery($db, "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [$key, strval($value)]);
    }
    
    $db->close();
    jsonResponse(['status' => 'success']);
    
} else {
    $db->close();
    jsonResponse(['error' => 'Method not allowed'], 405);
}
