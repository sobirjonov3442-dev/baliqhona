<?php
// Database configuration
define('DB_FILE', __DIR__ . '/database.db');

// CORS headers
function setCorsHeaders() {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Content-Type: application/json; charset=utf-8');
    
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(200);
        exit;
    }
}

// Check and fallback to PDO if SQLite3 is disabled
if (!class_exists('SQLite3')) {
    define('SQLITE3_ASSOC', 1);
    define('SQLITE3_TEXT', 3);
    define('SQLITE3_INTEGER', 1);
    define('SQLITE3_FLOAT', 2);
    
    class SQLite3Result {
        private $stmt;
        public function __construct($stmt) { $this->stmt = $stmt; }
        public function fetchArray($mode = SQLITE3_ASSOC) { return $this->stmt->fetch(PDO::FETCH_ASSOC); }
    }
    class SQLite3Stmt {
        private $stmt;
        public function __construct($stmt) { $this->stmt = $stmt; }
        public function bindValue($param, $val, $type = null) { $this->stmt->bindValue($param, $val); }
        public function execute() { $this->stmt->execute(); return new SQLite3Result($this->stmt); }
        public function reset() { return true; }
    }
    class SQLite3 {
        private $pdo;
        public function __construct($filename) {
            $this->pdo = new PDO('sqlite:' . $filename);
            $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        }
        public function enableExceptions($enable) {}
        public function busyTimeout($ms) {}
        public function query($sql) { return new SQLite3Result($this->pdo->query($sql)); }
        public function exec($sql) { return $this->pdo->exec($sql) !== false; }
        public function prepare($sql) { return new SQLite3Stmt($this->pdo->prepare($sql)); }
        public function close() { $this->pdo = null; }
        public function lastInsertRowID() { return $this->pdo->lastInsertId(); }
        public function querySingle($sql, $entireRow = false) {
            $stmt = $this->pdo->query($sql);
            if ($entireRow) {
                return $stmt->fetch(PDO::FETCH_ASSOC);
            }
            $row = $stmt->fetch(PDO::FETCH_NUM);
            return $row ? $row[0] : null;
        }
    }
}

// Get database connection
function getDB() {
    try {
        $db = new SQLite3(DB_FILE);
        $db->enableExceptions(true);
        $db->busyTimeout(5000);
        
        // Enable WAL mode for significantly better concurrency
        $db->exec('PRAGMA journal_mode = WAL;');
        $db->exec('PRAGMA synchronous = NORMAL;');
        
        return $db;
    } catch (Exception $e) {
        http_response_code(200); // Send 200 so JS can parse the error
        echo json_encode([
            'error' => 'DB_ERROR', 
            'message' => 'Baza xatosi: ' . $e->getMessage() . '. Fayl huquqlari (chmod 777) berilmagan bo\'lishi mumkin.'
        ]);
        exit;
    }
}

// Send JSON response
function jsonResponse($data, $statusCode = 200) {
    http_response_code($statusCode);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// Get JSON request body
function getRequestBody() {
    $input = file_get_contents('php://input');
    return json_decode($input, true) ?: [];
}

// Get all rows as associative array
function fetchAll($db, $sql, $params = []) {
    $stmt = $db->prepare($sql);
    foreach ($params as $key => $value) {
        $paramKey = is_int($key) ? $key + 1 : $key;
        $stmt->bindValue($paramKey, $value);
    }
    $result = $stmt->execute();
    $rows = [];
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
        $rows[] = $row;
    }
    return $rows;
}

// Get single row
function fetchOne($db, $sql, $params = []) {
    $stmt = $db->prepare($sql);
    foreach ($params as $key => $value) {
        $paramKey = is_int($key) ? $key + 1 : $key;
        $stmt->bindValue($paramKey, $value);
    }
    $result = $stmt->execute();
    return $result->fetchArray(SQLITE3_ASSOC);
}

// Execute query with params
function executeQuery($db, $sql, $params = []) {
    $stmt = $db->prepare($sql);
    foreach ($params as $key => $value) {
        $paramKey = is_int($key) ? $key + 1 : $key;
        $stmt->bindValue($paramKey, $value);
    }
    return $stmt->execute();
}
