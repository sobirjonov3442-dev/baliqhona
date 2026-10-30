<?php
/**
 * Main API Router — PHP Backend
 * Barcha API so'rovlarni tegishli fayllarga yo'naltiradi
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/init_db.php';

setCorsHeaders();

// Get request info
$requestUri = $_SERVER['REQUEST_URI'];
$method = $_SERVER['REQUEST_METHOD'];

// Remove query string
$path = parse_url($requestUri, PHP_URL_PATH);

// Get base path (if deployed in a subdirectory)
$scriptDir = dirname($_SERVER['SCRIPT_NAME']);
$basePath = str_replace('\\', '/', $scriptDir); // Handle Windows backslashes
if ($basePath === '/') $basePath = ''; // Root directory

// Strip base path from requested path
if ($basePath !== '' && strpos($path, $basePath) === 0) {
    $path = substr($path, strlen($basePath));
}

// Remove trailing slash
$path = rtrim($path, '/');

// Static file serving for frontend
if ($path === '' || $path === '/') {
    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__ . '/index.html');
    exit;
}

// Serve static files (CSS, JS)
$staticExtensions = ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'woff', 'woff2', 'ttf'];
$ext = pathinfo($path, PATHINFO_EXTENSION);
if (in_array($ext, $staticExtensions)) {
    $filePath = __DIR__ . '/' . ltrim($path, '/');
    if (file_exists($filePath)) {
        $mimeTypes = [
            'css' => 'text/css',
            'js' => 'application/javascript',
            'png' => 'image/png',
            'jpg' => 'image/jpeg',
            'jpeg' => 'image/jpeg',
            'gif' => 'image/gif',
            'ico' => 'image/x-icon',
            'svg' => 'image/svg+xml',
            'woff' => 'font/woff',
            'woff2' => 'font/woff2',
            'ttf' => 'font/ttf',
        ];
        header('Content-Type: ' . ($mimeTypes[$ext] ?? 'application/octet-stream'));
        readfile($filePath);
        exit;
    }
}

// API routing
// Extract path segments: /api/resource/id/action
if (preg_match('#^/api/(.+)$#', $path, $matches)) {
    $apiPath = $matches[1];
    $segments = explode('/', $apiPath);
    
    $resource = $segments[0] ?? '';
    $id = $segments[1] ?? null;
    $action = $segments[2] ?? null;
    
    switch ($resource) {
        case 'init':
            require __DIR__ . '/init.php';
            break;
            
        case 'users':
            require __DIR__ . '/users.php';
            break;
            
        case 'menus':
            require __DIR__ . '/menus.php';
            break;
            
        case 'orders':
            require __DIR__ . '/orders.php';
            break;
            
        case 'categories':
            require __DIR__ . '/categories.php';
            break;
            
        case 'settings':
            require __DIR__ . '/settings.php';
            break;
            
        case 'notifications':
            require __DIR__ . '/notifications.php';
            break;
            
        case 'salaries':
            require __DIR__ . '/salaries.php';
            break;
            
        case 'receipts':
            require __DIR__ . '/receipts.php';
            break;
            
        case 'inventory':
            require __DIR__ . '/inventory.php';
            break;
            
        case 'reset_all_data':
            require __DIR__ . '/reset.php';
            break;
            
        default:
            jsonResponse(['error' => 'Not found'], 404);
    }
} else {
    // Try to serve index.html for non-API routes
    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__ . '/index.html');
    exit;
}
