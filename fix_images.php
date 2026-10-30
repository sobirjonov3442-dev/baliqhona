<?php
/**
 * FIX SCRIPT: BARCHA mahsulot rasmlarini to'g'irlash
 * Brauzerda bir marta oching: https://senter-balq.uz/fix_images.php
 * Keyin bu faylni O'CHIRIB TASHLANG!
 */

require_once __DIR__ . '/config.php';

$db = getDB();

echo "<html><head><meta charset='utf-8'><title>Fix All Images</title></head><body style='font-family:sans-serif; padding:20px; background:#1a1a2e; color:#eee;'>";
echo "<h1>🔧 BARCHA mahsulot rasmlarini tuzatish (128 ta)</h1>";

$db->exec('BEGIN TRANSACTION');

try {
    $updated = 0;
    
    // ==========================================
    // KATEGORIYA BO'YICHA RASMLAR
    // Har bir kategoriya uchun mos, ishlaydigan rasm URL
    // ==========================================
    $categoryImages = [
        // BALIQLAR
        'oq_baliq'     => 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop',
        'sazan_baliq'  => 'https://images.unsplash.com/photo-1498654200943-1088dd4438ae?w=300&h=300&fit=crop',
        'ilon_baliq'   => 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=300&h=300&fit=crop',
        'amur_baliq'   => 'https://images.unsplash.com/photo-1510130113356-d94aeeeed1f7?w=300&h=300&fit=crop',
        'buxarskiy'    => 'https://images.unsplash.com/photo-1485921325833-c519f76c4927?w=300&h=300&fit=crop',
        'baliq'        => 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop',
        'baliqlar'     => 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop',

        // SHASHLIK
        'shashlik'     => 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=300&h=300&fit=crop',

        // OSH
        'osh'          => 'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=300&h=300&fit=crop',

        // BOLA (PALOV)
        'bola'         => 'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=300&h=300&fit=crop',

        // GO'SHT
        'gosht'        => 'https://images.unsplash.com/photo-1588168333986-5078d3ae3976?w=300&h=300&fit=crop',

        // TAMAT SOK
        'tamat_sok'    => 'https://images.unsplash.com/photo-1546548970-71785318a17b?w=300&h=300&fit=crop',

        // FAST FOOD
        'fastfood'     => 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300&h=300&fit=crop',

        // QONOTLAR
        'qonot'        => 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=300&h=300&fit=crop',

        // SALAT VA QO'SHIMCHA
        'salat'        => 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=300&h=300&fit=crop',

        // ICHIMLIKLAR (fallback)
        'ichimlik'     => 'https://images.unsplash.com/photo-1625772299848-391b6a87d7b3?w=300&h=300&fit=crop',

        // PEPSI (alohida kategoriya)
        'pepsi'        => 'https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=300&h=300&fit=crop',

        // FANTA (alohida kategoriya)
        'fanta'        => 'https://images.unsplash.com/photo-1624517452488-04869289c4ca?w=300&h=300&fit=crop',
    ];

    // ==========================================
    // NOM BO'YICHA ANIQ RASMLAR (ichimliklar uchun)
    // ==========================================
    $nameImages = [
        // COCA-COLA
        'Coca-Cola'   => 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300&h=300&fit=crop',
        'Coca Cola'   => 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300&h=300&fit=crop',
        'Cola'        => 'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=300&h=300&fit=crop',

        // PEPSI
        'Pepsi'       => 'https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=300&h=300&fit=crop',

        // FANTA
        'Fanta'       => 'https://images.unsplash.com/photo-1624517452488-04869289c4ca?w=300&h=300&fit=crop',
        'Sprite'      => 'https://images.unsplash.com/photo-1625772299848-391b6a87d7b3?w=300&h=300&fit=crop',

        // SUV
        'Oddiy suv'   => 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?w=300&h=300&fit=crop',
        'Suv'         => 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?w=300&h=300&fit=crop',

        // ENERGETIK
        'Flesh'       => 'https://images.unsplash.com/photo-1613214148962-eb7e8eb50462?w=300&h=300&fit=crop',
        'Gorilla'     => 'https://images.unsplash.com/photo-1613214148962-eb7e8eb50462?w=300&h=300&fit=crop',
        'Adrenaline'  => 'https://images.unsplash.com/photo-1613214148962-eb7e8eb50462?w=300&h=300&fit=crop',

        // FUSETEA
        'Fusetea'     => 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=300&h=300&fit=crop',

        // CHOY VA KOFE
        'Choy'        => 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=300&h=300&fit=crop',
        'Kofe'        => 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=300&h=300&fit=crop',

        // SHARBAT
        'Sharbat'     => 'https://images.unsplash.com/photo-1534353473418-4cfa6c56fd38?w=300&h=300&fit=crop',

        // FAST FOOD - aniq nomlar
        'Gamburger'     => 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=300&h=300&fit=crop',
        'Cheeseburger'  => 'https://images.unsplash.com/photo-1550547660-d9450f859349?w=300&h=300&fit=crop',
        'Double burger' => 'https://images.unsplash.com/photo-1586190848861-99aa4a171e90?w=300&h=300&fit=crop',
        'Fri kartoshka' => 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=300&h=300&fit=crop',
        'Hot-dog'       => 'https://images.unsplash.com/photo-1612392062126-a07483e2e7d6?w=300&h=300&fit=crop',
        'Lavash'        => 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=300&h=300&fit=crop',
        'Shovirma'      => 'https://images.unsplash.com/photo-1529006557810-274b9b2fc783?w=300&h=300&fit=crop',

        // SHASHLIK - aniq nomlar
        'Qirqma shashlik'       => 'https://images.unsplash.com/photo-1529694157872-4e0c0f3b238b?w=300&h=300&fit=crop',
        'Qiyma shashlik'        => 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=300&h=300&fit=crop',
        'Onat shashlik'         => 'https://images.unsplash.com/photo-1544025162-d76694265947?w=300&h=300&fit=crop',
        'Jigar shashlik'        => 'https://images.unsplash.com/photo-1603360946369-dc9bb6258143?w=300&h=300&fit=crop',
        'O\'rama shashlik'      => 'https://images.unsplash.com/photo-1529694157872-4e0c0f3b238b?w=300&h=300&fit=crop',
        'Mol go\'shti shashlik' => 'https://images.unsplash.com/photo-1558030006-450675393462?w=300&h=300&fit=crop',
        'Tovuq shashlik'        => 'https://images.unsplash.com/photo-1532636875601-8e7d6a5e9f0e?w=300&h=300&fit=crop',
        'Qoy go\'shti shashlik' => 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=300&h=300&fit=crop',
        'Aralash shashlik'      => 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=300&h=300&fit=crop',
        'Shashlik (1 dona)'     => 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=300&h=300&fit=crop',

        // GO'SHT - aniq nomlar
        'Bifshteks'             => 'https://images.unsplash.com/photo-1600891964092-4316c288032e?w=300&h=300&fit=crop',
        'Mol go\'shti (grill)'  => 'https://images.unsplash.com/photo-1558030006-450675393462?w=300&h=300&fit=crop',
        'Tovuq go\'shti'        => 'https://images.unsplash.com/photo-1598103442097-8b74394b95c6?w=300&h=300&fit=crop',
        'Qovurma'               => 'https://images.unsplash.com/photo-1574484284002-952d92456975?w=300&h=300&fit=crop',
        'Jiz (go\'sht)'         => 'https://images.unsplash.com/photo-1588168333986-5078d3ae3976?w=300&h=300&fit=crop',

        // QONOTLAR - aniq nomlar
        'Tovuq qanot'           => 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=300&h=300&fit=crop',
        'Qanot'                 => 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=300&h=300&fit=crop',
        'Tabaki qonot'          => 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=300&h=300&fit=crop',
        'Giril qonot'           => 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=300&h=300&fit=crop',
        'Pachka qonot'          => 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=300&h=300&fit=crop',
        'BBQ qonot'             => 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=300&h=300&fit=crop',
        'Spesial qonot'         => 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=300&h=300&fit=crop',

        // SALAT
        'Salat'                 => 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=300&h=300&fit=crop',
        'Lazgi'                 => 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=300&h=300&fit=crop',
        'Non'                   => 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=300&h=300&fit=crop',
        'Sho\'rva'              => 'https://images.unsplash.com/photo-1547592166-23ac45744acd?w=300&h=300&fit=crop',

        // TAMAT SOK
        'Sovis Tamat'           => 'https://images.unsplash.com/photo-1546548970-71785318a17b?w=300&h=300&fit=crop',
    ];

    // ==========================================
    // BARCHA MENYU ELEMENTLARINI OLISH VA YANGILASH
    // ==========================================
    $allItems = fetchAll($db, "SELECT id, name, category, icon FROM menu ORDER BY id");
    
    echo "<table style='width:100%; border-collapse:collapse; margin-top:20px;'>";
    echo "<tr style='background:#333; color:#fff;'><th style='padding:8px; border:1px solid #555;'>ID</th><th style='padding:8px; border:1px solid #555;'>Nomi</th><th style='padding:8px; border:1px solid #555;'>Kategoriya</th><th style='padding:8px; border:1px solid #555;'>Eski rasm</th><th style='padding:8px; border:1px solid #555;'>Yangi rasm</th><th style='padding:8px; border:1px solid #555;'>Status</th></tr>";
    
    foreach ($allItems as $item) {
        $id = $item['id'];
        $name = $item['name'];
        $category = $item['category'];
        $oldIcon = $item['icon'] ?? '';
        $newIcon = null;
        
        // Rasmni aniqlash usullari (prioritet tartibi):
        
        // 1. AGAR rasm allaqachon ishlaydigan URL bo'lsa — o'zgartirmaymiz
        $isValidUrl = preg_match('/^https?:\/\/images\.unsplash\.com/', $oldIcon);
        
        if ($isValidUrl) {
            echo "<tr style='background:#1a2e1a;'><td style='padding:6px; border:1px solid #555;'>{$id}</td><td style='padding:6px; border:1px solid #555;'>{$name}</td><td style='padding:6px; border:1px solid #555;'>{$category}</td><td style='padding:6px; border:1px solid #555; font-size:0.7rem;'>" . substr($oldIcon, 0, 40) . "...</td><td style='padding:6px; border:1px solid #555;'>—</td><td style='padding:6px; border:1px solid #555; color:#4ade80;'>✅ OK</td></tr>";
            continue;
        }
        
        // 2. Aniq nom bo'yicha rasm qidirish
        foreach ($nameImages as $keyword => $url) {
            if (stripos($name, $keyword) === 0 || $name === $keyword) {
                $newIcon = $url;
                break;
            }
        }
        
        // 3. Agar aniq nom topilmasa — nom ichida keyword qidirish
        if (!$newIcon) {
            foreach ($nameImages as $keyword => $url) {
                if (stripos($name, $keyword) !== false) {
                    $newIcon = $url;
                    break;
                }
            }
        }
        
        // 4. Agar hali topilmasa — kategoriya bo'yicha fallback
        if (!$newIcon && isset($categoryImages[$category])) {
            $newIcon = $categoryImages[$category];
        }
        
        // 5. Agar hech narsa topilmasa — umumiy ovqat rasmi
        if (!$newIcon) {
            $newIcon = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=300&h=300&fit=crop';
        }
        
        // YANGILASH
        executeQuery($db, "UPDATE menu SET icon = ? WHERE id = ?", [$newIcon, $id]);
        $updated++;
        
        $shortOld = $oldIcon ? substr($oldIcon, 0, 30) . '...' : '(bo\'sh)';
        $shortNew = substr($newIcon, 0, 40) . '...';
        echo "<tr style='background:#2e1a1a;'><td style='padding:6px; border:1px solid #555;'>{$id}</td><td style='padding:6px; border:1px solid #555;'>{$name}</td><td style='padding:6px; border:1px solid #555;'>{$category}</td><td style='padding:6px; border:1px solid #555; font-size:0.7rem; color:#f87171;'>{$shortOld}</td><td style='padding:6px; border:1px solid #555; font-size:0.7rem; color:#4ade80;'>{$shortNew}</td><td style='padding:6px; border:1px solid #555; color:#fbbf24;'>🔄 Yangilandi</td></tr>";
    }
    
    echo "</table>";
    
    $db->exec('COMMIT');
    
    echo "<hr>";
    echo "<h2 style='color:#4ade80;'>✅ Jami {$updated} ta mahsulot rasmi yangilandi!</h2>";
    echo "<p>Jami menyu elementlari: " . count($allItems) . " ta</p>";
    echo "<p style='color:#f87171; font-weight:bold; font-size:1.2rem;'>⚠️ Endi bu faylni serverdan O'CHIRIB TASHLANG!</p>";
    echo "<p><a href='/' style='color:#60a5fa; font-size:1.2rem;'>← Bosh sahifaga qaytish</a></p>";
    
} catch (Exception $e) {
    $db->exec('ROLLBACK');
    echo "<h2 style='color:#f87171;'>❌ Xatolik: " . $e->getMessage() . "</h2>";
    echo "<pre style='color:#fbbf24;'>" . $e->getTraceAsString() . "</pre>";
}

$db->close();
echo "</body></html>";
