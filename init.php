<?php
/**
 * GET /api/init — Barcha ma'lumotlarni qaytarish
 */

$db = getDB();

// Temporary patch to add Buxarskiy baliq
$cat = fetchOne($db, "SELECT id FROM categories WHERE value = 'buxarskiy'");
if (!$cat) {
    executeQuery($db, "INSERT INTO categories (id, name, value) VALUES ('cat_buxarskiy', 'Buxarskiy baliq', 'buxarskiy')");
    $maxId = fetchOne($db, "SELECT MAX(id) as max FROM menu");
    $newId = ($maxId['max'] ?? 3000) + 1;
    executeQuery($db, "INSERT INTO menu (id, icon, name, category, price, unit, quantity, weight_per_piece, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        $newId,
        'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop',
        'Buxarskiy baliq 1 kg',
        'buxarskiy',
        100000,
        'kg',
        9999,
        1.0,
        1
    ]);
}


// Long Polling setup
set_time_limit(30); // Prevent PHP script from timing out early
if (session_status() === PHP_SESSION_ACTIVE) session_write_close(); // Prevent session locking

$client_last_updated = $_GET['last_updated'] ?? '';

$global_last_updated_row = fetchAll($db, "SELECT value FROM settings WHERE key = 'global_last_updated'");
$global_last_updated = !empty($global_last_updated_row) ? (string)$global_last_updated_row[0]['value'] : '1';

if ($client_last_updated !== '' && $client_last_updated === $global_last_updated) {
    $db->close();
    jsonResponse(['changed' => false]);
    exit;
}

// Users
$users = fetchAll($db, "SELECT * FROM users");

// Menu
$menuRaw = fetchAll($db, "SELECT * FROM menu");

// Barcha menyu tarkiblarini bitta so'rovda olish (N+1 xatoligini bartaraf etish)
$allIngredientsRaw = fetchAll($db, "SELECT mi.menu_id, i.quantity as inv_qty, i.unit as inv_unit FROM menu_ingredients mi JOIN inventory i ON mi.inventory_id = i.id");
$ingredientsMap = [];
foreach ($allIngredientsRaw as $ing) {
    $mId = $ing['menu_id'];
    if (!isset($ingredientsMap[$mId])) {
        $ingredientsMap[$mId] = [];
    }
    $ingredientsMap[$mId][] = $ing;
}

$menu = [];
foreach ($menuRaw as $m) {
    $mId = $m['id'];
    if (isset($ingredientsMap[$mId]) && count($ingredientsMap[$mId]) > 0) {
        $m['quantity'] = floatval($ingredientsMap[$mId][0]['inv_qty']);
        $m['unit'] = $ingredientsMap[$mId][0]['inv_unit'];
    }
    $menu[] = $m;
}

// Categories
$categories = fetchAll($db, "SELECT * FROM categories");

// Settings
$settingsRaw = fetchAll($db, "SELECT * FROM settings");
$settings = [];
foreach ($settingsRaw as $s) {
    $settings[$s['key']] = $s['value'];
}

// Orders (items JSON ni parse qilish)
// Faqat faol buyurtmalarni va oxirgi 1 kun ichidagi yakunlanganlarni olamiz (payload qotmasligi uchun)
$oneDayAgo = date('c', strtotime('-1 days'));
$ordersRaw = fetchAll($db, "SELECT * FROM orders WHERE status NOT IN ('completed', 'cancelled', 'archived') OR timestamp >= ?", [$oneDayAgo]);
$orders = [];
foreach ($ordersRaw as $o) {
    $o['items'] = json_decode($o['items'], true) ?: [];
    $orders[] = $o;
}

// Notifications (faqat o'qilmaganlar yoki oxirgi 50 tasi)
$notifications = fetchAll($db, "SELECT * FROM notifications ORDER BY timestamp DESC LIMIT 50");
foreach ($notifications as &$n) {
    $n['read'] = (bool)$n['read'];
}

// Salaries
$salaries = fetchAll($db, "SELECT * FROM salaries");

// Inventory
$inventory = fetchAll($db, "SELECT * FROM inventory");

$db->close();

jsonResponse([
    'changed' => true,
    'last_updated' => $global_last_updated,
    'users' => $users,
    'menu' => $menu,
    'categories' => $categories,
    'settings' => $settings,
    'orders' => $orders,
    'notifications' => $notifications,
    'salaries' => $salaries,
    'inventory' => $inventory
]);
