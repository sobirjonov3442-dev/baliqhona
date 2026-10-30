<?php
require_once __DIR__ . '/config.php';

function initDatabase() {
    $db = getDB();
    
    // Create tables
    $db->exec('CREATE TABLE IF NOT EXISTS users
        (id INTEGER PRIMARY KEY, role TEXT, name TEXT, phone TEXT, login TEXT, password TEXT)');
    
    $db->exec('CREATE TABLE IF NOT EXISTS menu
        (id INTEGER PRIMARY KEY, icon TEXT, name TEXT, category TEXT, price REAL, unit TEXT, quantity REAL, weight_per_piece REAL, active INTEGER DEFAULT 1)');
    
    $db->exec('CREATE TABLE IF NOT EXISTS orders
        (id TEXT PRIMARY KEY, "table" TEXT, peopleCount INTEGER, items TEXT, total REAL, status TEXT, waiterId TEXT, chefId INTEGER, timestamp TEXT, completedAt TEXT, receiptPrinted INTEGER DEFAULT 0, customerName TEXT)');
    
    $db->exec('CREATE TABLE IF NOT EXISTS notifications
        (id INTEGER PRIMARY KEY, userId TEXT, message TEXT, type TEXT, read INTEGER, timestamp TEXT)');
    
    $db->exec('CREATE TABLE IF NOT EXISTS categories
        (id TEXT PRIMARY KEY, name TEXT, value TEXT)');
    
    $db->exec('CREATE TABLE IF NOT EXISTS settings
        (key TEXT PRIMARY KEY, value TEXT)');
    
    $db->exec('CREATE TABLE IF NOT EXISTS salaries
        (id TEXT PRIMARY KEY, userId TEXT, amount REAL, percentage REAL, date TEXT, timestamp TEXT)');
    
    $db->exec('CREATE TABLE IF NOT EXISTS receipts
        (id INTEGER PRIMARY KEY AUTOINCREMENT, "table" TEXT, items TEXT, total REAL, service_charge REAL, cash_given REAL, timestamp TEXT)');
    
    $db->exec('CREATE TABLE IF NOT EXISTS inventory
        (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, unit TEXT DEFAULT "kg", quantity REAL DEFAULT 0, price REAL DEFAULT 0, min_alert REAL DEFAULT 0, icon TEXT, created_at TEXT, updated_at TEXT)');
    
    $db->exec('CREATE TABLE IF NOT EXISTS menu_ingredients
        (id INTEGER PRIMARY KEY AUTOINCREMENT, menu_id INTEGER, inventory_id INTEGER, quantity REAL, unit TEXT, FOREIGN KEY(menu_id) REFERENCES menu(id), FOREIGN KEY(inventory_id) REFERENCES inventory(id))');
    
    // ALTER TABLE attempts for migration compatibility
    $alterColumns = [
        'menu' => ['unit TEXT', 'quantity REAL', 'weight_per_piece REAL', 'active INTEGER DEFAULT 1'],
        'orders' => ['completedAt TEXT', 'receiptPrinted INTEGER DEFAULT 0', 'customerName TEXT', 'deliveredBy TEXT'],
        'notifications' => ['orderId TEXT']
    ];
    
    foreach ($alterColumns as $table => $columns) {
        foreach ($columns as $colDef) {
            $colName = explode(' ', $colDef)[0];
            try {
                $db->exec("ALTER TABLE $table ADD COLUMN $colDef");
            } catch (Exception $e) {
                // Column already exists, ignore
            }
        }
    }
    
    // Check if users table is empty, then insert default data
    $count = $db->querySingle("SELECT COUNT(*) FROM users");
    if ($count == 0) {
        // Default users
        $db->exec("INSERT INTO users (id, role, name, phone, login, password) VALUES (1, 'admin', 'Admin', '000', '47789', '5567')");
        $db->exec("INSERT INTO users (id, role, name, phone, login, password) VALUES (2, 'chef', 'Chef Mario', '+998901234567', 'chef1', '123')");
        $db->exec("INSERT INTO users (id, role, name, phone, login, password) VALUES (3, 'waiter', 'Waiter John', '+998907654321', 'waiter1', '123')");
        
        // Default kategoriyalar
        $categories = [
            ['cat_baliq', 'Baliq', 'baliq'],
            ['cat_buxarskiy', 'Buxarskiy baliq', 'buxarskiy'],
            ['cat_ichimlik', 'Ichimliklar', 'ichimlik'],
            ['cat_shashlik', 'Shashlik', 'shashlik'],
            ['cat_taom', 'Taomlar', 'taom'],
        ];
        $catStmt = $db->prepare("INSERT INTO categories (id, name, value) VALUES (?, ?, ?)");
        foreach ($categories as $cat) {
            $catStmt->bindValue(1, $cat[0]);
            $catStmt->bindValue(2, $cat[1]);
            $catStmt->bindValue(3, $cat[2]);
            $catStmt->execute();
            $catStmt->reset();
        }
        
        // Default baliq mahsulotlari
        $fishProducts = [
            [1001, 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop', 'Oq baliq 0.5 kg', 'baliq', 25000, 'kg', 50, 0.5],
            [1002, 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop', 'Oq baliq 0.6 kg', 'baliq', 30000, 'kg', 50, 0.6],
            [1003, 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop', 'Oq baliq 0.7 kg', 'baliq', 35000, 'kg', 50, 0.7],
            [1004, 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop', 'Oq baliq 1 kg', 'baliq', 50000, 'kg', 50, 1.0],
            [1005, 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop', 'Oq baliq 1.2 kg', 'baliq', 60000, 'kg', 50, 1.2],
            [1006, 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop', 'Oq baliq 1.5 kg', 'baliq', 75000, 'kg', 50, 1.5],
            [1007, 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop', 'Oq baliq 2 kg', 'baliq', 100000, 'kg', 50, 2.0],
            [1008, 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop', 'Buxarskiy baliq 1 kg', 'buxarskiy', 100000, 'kg', 50, 1.0],
        ];
        
        $menuStmt = $db->prepare("INSERT INTO menu (id, icon, name, category, price, unit, quantity, weight_per_piece) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        foreach ($fishProducts as $fp) {
            for ($i = 0; $i < 8; $i++) {
                $menuStmt->bindValue($i + 1, $fp[$i]);
            }
            $menuStmt->execute();
            $menuStmt->reset();
        }
        
        // Default ichimlik mahsulotlari
        $drinkProducts = [
            // Fanta
            [2003, 'https://images.unsplash.com/photo-1624517452488-04869289c4ca?w=300&h=300&fit=crop', 'Fanta 0.5L', 'ichimlik', 8000, 'dona', 100, null],
            [2004, 'https://images.unsplash.com/photo-1624517452488-04869289c4ca?w=300&h=300&fit=crop', 'Fanta 1L', 'ichimlik', 12000, 'dona', 100, null],
            [2009, 'https://images.unsplash.com/photo-1624517452488-04869289c4ca?w=300&h=300&fit=crop', 'Fanta 1.5L', 'ichimlik', 16000, 'dona', 100, null],
            [2010, 'https://images.unsplash.com/photo-1624517452488-04869289c4ca?w=300&h=300&fit=crop', 'Fanta 2L', 'ichimlik', 20000, 'dona', 100, null],

            // Pepsi
            [2001, 'https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=300&h=300&fit=crop', 'Pepsi 0.5L', 'ichimlik', 8000, 'dona', 100, null],
            [2002, 'https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=300&h=300&fit=crop', 'Pepsi 1L', 'ichimlik', 12000, 'dona', 100, null],
            [2007, 'https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=300&h=300&fit=crop', 'Pepsi 1.5L', 'ichimlik', 16000, 'dona', 100, null],
            [2008, 'https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=300&h=300&fit=crop', 'Pepsi 2L', 'ichimlik', 20000, 'dona', 100, null],

            // Coca-Cola
            [2005, 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300&h=300&fit=crop', 'Coca-Cola 0.5L', 'ichimlik', 8000, 'dona', 100, null],
            [2006, 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300&h=300&fit=crop', 'Coca-Cola 1L', 'ichimlik', 12000, 'dona', 100, null],
            [2022, 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300&h=300&fit=crop', 'Coca-Cola 1.5L', 'ichimlik', 16000, 'dona', 100, null],
            [2023, 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300&h=300&fit=crop', 'Coca-Cola 2L', 'ichimlik', 20000, 'dona', 100, null],

            // Oddiy suv
            [2011, 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?w=300&h=300&fit=crop', 'Oddiy suv 0.5L', 'ichimlik', 3000, 'dona', 100, null],
            [2012, 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?w=300&h=300&fit=crop', 'Oddiy suv 1L', 'ichimlik', 5000, 'dona', 100, null],
            [2013, 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?w=300&h=300&fit=crop', 'Oddiy suv 1.5L', 'ichimlik', 7000, 'dona', 100, null],
            [2014, 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?w=300&h=300&fit=crop', 'Oddiy suv 2L', 'ichimlik', 9000, 'dona', 100, null],

            // Energy Drinks
            [2015, 'https://images.unsplash.com/photo-1613214148962-eb7e8eb50462?w=300&h=300&fit=crop', 'Flesh', 'ichimlik', 12000, 'dona', 100, null],
            [2016, 'https://images.unsplash.com/photo-1613214148962-eb7e8eb50462?w=300&h=300&fit=crop', 'Gorilla', 'ichimlik', 12000, 'dona', 100, null],
            [2017, 'https://images.unsplash.com/photo-1613214148962-eb7e8eb50462?w=300&h=300&fit=crop', 'Adrenaline', 'ichimlik', 16000, 'dona', 100, null],

            // Fusetea
            [2018, 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=300&h=300&fit=crop', 'Fusetea 0.5L', 'ichimlik', 9000, 'dona', 100, null],
            [2019, 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=300&h=300&fit=crop', 'Fusetea 1L', 'ichimlik', 14000, 'dona', 100, null],
            [2020, 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=300&h=300&fit=crop', 'Fusetea 1.5L', 'ichimlik', 18000, 'dona', 100, null],
            [2021, 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=300&h=300&fit=crop', 'Fusetea 2L', 'ichimlik', 22000, 'dona', 100, null],
        ];
        
        foreach ($drinkProducts as $dp) {
            for ($i = 0; $i < 8; $i++) {
                $menuStmt->bindValue($i + 1, $dp[$i]);
            }
            $menuStmt->execute();
            $menuStmt->reset();
        }
        
        // Default shashlik mahsulotlari
        $shashlikProducts = [
            [3001, 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=300&h=300&fit=crop', 'Qiyma shashlik', 'shashlik', 15000, 'dona', 100, null],
            [3002, 'https://images.unsplash.com/photo-1529694157872-4e0c0f3b238b?w=300&h=300&fit=crop', 'Qirqma shashlik', 'shashlik', 18000, 'dona', 100, null],
        ];
        
        foreach ($shashlikProducts as $sp) {
            for ($i = 0; $i < 8; $i++) {
                $menuStmt->bindValue($i + 1, $sp[$i]);
            }
            $menuStmt->execute();
            $menuStmt->reset();
        }
        
        // Qanot (1 kg)
        executeQuery($db, "INSERT INTO menu (id, icon, name, category, price, unit, quantity, weight_per_piece) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [3003, 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=300&h=300&fit=crop', 'Qanot (1 kg)', 'taom', 45000, 'kg', 30, 1.0]);
        
        // Osh (1 kg)
        executeQuery($db, "INSERT INTO menu (id, icon, name, category, price, unit, quantity, weight_per_piece) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [3004, 'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=300&h=300&fit=crop', 'Osh (1 kg)', 'taom', 35000, 'kg', 50, 1.0]);
        
        // Default settings
        $settings = [
            ['app_name', 'Gourmet Manager Pro'],
            ['logo_icon', 'fa-utensils'],
            ['primary_color', '#4f46e5'],
            ['accent_color', '#ec4899'],
            ['font_family', 'Inter'],
            ['language', 'uz']
        ];
        $settingsStmt = $db->prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
        foreach ($settings as $s) {
            $settingsStmt->bindValue(1, $s[0]);
            $settingsStmt->bindValue(2, $s[1]);
            $settingsStmt->execute();
            $settingsStmt->reset();
        }
    }
    
    // Har doim admin parolini yangilash
    $db->exec("UPDATE users SET login='47789', password='5567' WHERE role='admin'");
    
    // Create indexes to avoid full table scans and freezing
    $db->exec("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_orders_timestamp ON orders(timestamp)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_notifications_timestamp ON notifications(timestamp)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_menu_ingredients_menu_id ON menu_ingredients(menu_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS idx_menu_ingredients_inv_id ON menu_ingredients(inventory_id)");
    
    // Initialize global_last_updated setting if not exists
    $db->exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('global_last_updated', '1')");
    
    // Create triggers for all relevant tables to act as an atomic update counter
    $tablesToTrigger = ['orders', 'menu', 'inventory', 'notifications', 'users', 'receipts', 'categories', 'menu_ingredients', 'salaries'];
    foreach ($tablesToTrigger as $t) {
        $db->exec("CREATE TRIGGER IF NOT EXISTS update_global_state_{$t}_insert AFTER INSERT ON {$t} BEGIN UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'global_last_updated'; END;");
        $db->exec("CREATE TRIGGER IF NOT EXISTS update_global_state_{$t}_update AFTER UPDATE ON {$t} BEGIN UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'global_last_updated'; END;");
        $db->exec("CREATE TRIGGER IF NOT EXISTS update_global_state_{$t}_delete AFTER DELETE ON {$t} BEGIN UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'global_last_updated'; END;");
    }
    
    $db->close();
}

// Initialize on include only once to prevent schema locking on every API request
if (!file_exists(__DIR__ . '/.db_initialized_v3')) {
    initDatabase();
    file_put_contents(__DIR__ . '/.db_initialized_v3', '1');
}
