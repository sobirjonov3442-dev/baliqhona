let API_BASE = "api";

if (window.location.protocol === 'file:') {
    API_BASE = "http://localhost:5000/api";
} else {
    let path = window.location.pathname;
    // Strip filename if exists (like index.php, index.html)
    if (path.match(/\/[^\/]+\.(html|php)$/i)) {
        path = path.substring(0, path.lastIndexOf('/'));
    }
    // Remove trailing slash
    path = path.replace(/\/$/, '');
    API_BASE = path + "/api";
}

// --- SMART REQUEST QUEUE ---
const originalFetch = window.fetch;
class RequestQueue {
    constructor(maxConcurrent = 3) {
        this.queue = [];
        this.activeCount = 0;
        this.maxConcurrent = maxConcurrent;
        this.inFlightGetRequests = new Map();
    }

    async fetch(url, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        
        // 5. Exclude long polling/SSE
        if (typeof url === 'string' && (url.includes('/init') || url.includes('poll') || url.includes('stream'))) {
            return originalFetch(url, options);
        }

        // 2. Deduplication for GET requests only
        const cacheKey = `${method}:${url}`;
        if (method === 'GET' && this.inFlightGetRequests.has(cacheKey)) {
            return this.inFlightGetRequests.get(cacheKey);
        }

        const promise = new Promise((resolve, reject) => {
            this.queue.push({ url, options, method, resolve, reject, retries: 0 });
            this.processQueue();
        });

        if (method === 'GET') {
            this.inFlightGetRequests.set(cacheKey, promise);
            promise.finally(() => this.inFlightGetRequests.delete(cacheKey));
        }

        return promise;
    }

    async processQueue() {
        if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) return;

        const request = this.queue.shift();
        this.activeCount++;

        try {
            // 6. Timeout 15s
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            
            const response = await originalFetch(request.url, {
                ...request.options,
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok && response.status >= 500) {
                throw new Error(`Server error: ${response.status}`);
            }
            
            request.resolve(response);
        } catch (error) {
            // 3, 4, 6. Retry max 2 times, ONLY for GET (safe) requests
            const isSafeToRetry = request.method === 'GET';
            
            if (isSafeToRetry && request.retries < 2 && (error.name === 'AbortError' || error.message.includes('Server error') || error.message.includes('fetch') || error.message.includes('Network') || error.message.includes('Failed to fetch'))) {
                request.retries++;
                console.warn(`[Queue] Request failed, retrying (${request.retries}/2): ${request.url}`);
                this.queue.unshift(request); // Put back at the front
            } else {
                request.reject(error);
            }
        } finally {
            this.activeCount--;
            this.processQueue();
        }
    }
}

const apiQueue = new RequestQueue(3);
window.fetch = (url, options) => apiQueue.fetch(url, options);
// -----------------------------

const notificationSound = new Audio("data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU"+ "A".repeat(100));
const audioUrl = "https://actions.google.com/sounds/v1/alarms/beep_short.ogg";
const alertAudio = new Audio(audioUrl);

let currentUser = null;
let currentCart = [];
let currentCategory = 'all';
let profitChartInstance = null;
let previousPendingCount = 0;

let adminOrdersCategory = 'all';
let adminSaboyCategory = 'all';
let chefOrdersCategory = 'active';
let chefSaboyCategory = 'active';

// Application state from DB
let state = {
    users: [],
    menu: [],
    categories: [],
    orders: [],
    notifications: [],
    salaries: []
};

const sections = {
    login: document.getElementById('login-section'),
    admin: document.getElementById('admin-dashboard'),
    chef: document.getElementById('chef-dashboard'),
    waiter: document.getElementById('waiter-dashboard'),
    'zone-selection-section': document.getElementById('zone-selection-section')
};

let lastUpdatedTimestamp = '';

async function fetchData() {
    try {
        const res = await fetch(`${API_BASE}/init?last_updated=${lastUpdatedTimestamp}`);
        const data = await res.json();
        
        if (data.changed === false) {
            return false;
        }
        if (data.last_updated) {
            lastUpdatedTimestamp = data.last_updated;
        }
        
        if (data.error === 'DB_ERROR') {
            alert("BAZA XATOSI: " + data.message);
        }
        
        state.users = data.users || [];
        state.menu = data.menu || [];
        state.categories = data.categories || [];
        state.settings = data.settings || {};
        applySettings();
        state.orders = data.orders || [];
        state.notifications = data.notifications || [];
        state.salaries = data.salaries || [];
        if (data.inventory) {
            inventoryItems = data.inventory;
            if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'chef')) {
                renderAdminInventory();
                renderChefStore();
            }
        }
        
        return true;
    } catch(e) {
        console.error("Backend ulanmadi", e);
        return false;
    }
}

async function init() {
    // Check if user is logged in
    const storedUser = localStorage.getItem('currentUser');
    if (storedUser) {
        currentUser = JSON.parse(storedUser);
        if (currentUser.role === 'waiter' && !currentUser.zone) {
            showSection('zone-selection-section');
        } else {
            showDashboard(currentUser.role); // Show immediately
        }
    } else {
        showSection('login');
    }

    await fetchData();
    
    if (currentUser) {
        updateDashboards(currentUser.role, true); // Re-render with data
    }
    
    setupEventListeners();
    
    // Auto refresh data with adaptive polling
    let isFetching = false;
    let pollInterval = 3000;

    async function startAdaptivePolling() {
        if (currentUser && !isFetching) {
            isFetching = true;
            try {
                const changed = await fetchData();
                if (changed) {
                    updateDashboards(currentUser.role, false);
                    checkAudioAlert();
                }
                pollInterval = document.visibilityState === 'hidden' ? 5000 : 1000;
            } catch (error) {
                console.error(error);
                pollInterval = Math.min(15000, pollInterval + 3000); // Backoff on error
            } finally {
                isFetching = false;
            }
        }
        setTimeout(startAdaptivePolling, pollInterval);
    }
    
    setTimeout(startAdaptivePolling, pollInterval);
}

function login(loginStr, passwordStr) {
    loginStr = String(loginStr).trim();
    passwordStr = String(passwordStr).trim();
    const user = state.users.find(u => String(u.login).trim() === loginStr && String(u.password).trim() === passwordStr);
    if (user) {
        currentUser = user;
        document.getElementById('login-error').textContent = '';
        
        if (currentUser.role === 'waiter') {
            showSection('zone-selection-section');
        } else {
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
            showToast(`Xush kelibsiz, ${currentUser.name}!`, 'success');
            showDashboard(currentUser.role);
        }
        alertAudio.play().then(() => { alertAudio.pause(); alertAudio.currentTime = 0; }).catch(()=>{});
    } else {
        document.getElementById('login-error').textContent = 'Login yoki parol xato';
    }
}

window.selectZone = function(zone) {
    if (!currentUser) return;
    currentUser.zone = zone;
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
    showToast(`Xush kelibsiz, ${currentUser.name}! Hudud: ${zone === 'choyxona' ? 'Choyxona' : 'Baliq Xona'}`, 'success');
    showDashboard(currentUser.role);
    
    // Default View Selection Based on Zone
    document.querySelectorAll('.waiter-subview').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.waiter-nav').forEach(n => n.classList.remove('active'));
    
    const mapNavBtn = document.querySelector('.waiter-nav[data-target="waiter-view-map"]');
    
    // Choyxona uchun ham, Baliq Xona uchun ham Xarita ochiladi
    document.getElementById('waiter-view-map').classList.add('active');
    document.querySelector('.waiter-nav[data-target="waiter-view-map"]').classList.add('active');
    
    // Xarita tugmasini ko'rsatamiz
    if(mapNavBtn) mapNavBtn.style.display = 'block';
};

function logout() {
    currentUser = null;
    localStorage.removeItem('currentUser');
    showSection('login');
}

function showSection(sectionId) {
    Object.values(sections).forEach(s => s.classList.remove('active'));
    if (sections[sectionId]) sections[sectionId].classList.add('active');
}

function showDashboard(role) {
    showSection(role);
    updateDashboards(role, true);
}

function updateDashboards(role, renderChartAnim = false) {
    if (role === 'admin') {
        renderAdminDashboard(renderChartAnim);
        if (typeof renderAdminMap === 'function') renderAdminMap();
        if (typeof renderDailySales === 'function') renderDailySales();
    } else if (role === 'chef') {
        renderChefDashboard();
        renderChefSaboyOrders();
        renderChefStore();
        if (typeof renderChefMyOrders === 'function') renderChefMyOrders();
        if (typeof renderUserProfile === 'function') renderUserProfile('chef');
    } else if (role === 'waiter') {
        renderWaiterDashboard();
        if (typeof renderWaiterMyOrders === 'function') renderWaiterMyOrders();
        if (typeof renderWaiterMap === 'function') renderWaiterMap();
        if (typeof renderUserProfile === 'function') renderUserProfile('waiter');
    }
}

function showToast(message, type = 'info') {
    const container = document.getElementById('notification-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    let icon = type === 'success' ? 'fa-check-circle' : type === 'warning' ? 'fa-exclamation-triangle' : type === 'danger' ? 'fa-times-circle' : 'fa-info-circle';
    toast.innerHTML = `<i class="fas ${icon}"></i> <span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function applySettings() {
    const s = state.settings || {};
    const getSetting = (k, def) => s[k] || def;
    
    const style = document.getElementById('dynamic-theme');
    if (style) {
        style.innerHTML = `
            :root {
                --primary-color: ${getSetting('primary_color', '#4f46e5')} !important;
                --accent-color: ${getSetting('accent_color', '#ec4899')} !important;
            }
            body { font-family: '${getSetting('font_family', 'Inter')}', sans-serif; }
        `;
    }
    
    document.querySelectorAll('.app-name-display').forEach(el => {
        el.textContent = getSetting('app_name', 'Gourmet Manager Pro');
    });
    
    const logoClass = getSetting('logo_icon', 'fa-utensils');
    document.querySelectorAll('.app-logo-icon').forEach(el => {
        if (logoClass.startsWith('data:image') || logoClass.startsWith('http')) {
            el.innerHTML = `<img src="${logoClass}" style="width: 100%; height: 100%; object-fit: contain;">`;
            el.className = 'app-logo-icon';
            el.style.display = 'inline-block';
            el.style.width = '30px';
            el.style.height = '30px';
        } else {
            el.innerHTML = '';
            el.className = 'app-logo-icon fas ' + (logoClass.startsWith('fa-') ? logoClass : 'fa-' + logoClass);
            el.style.width = '';
            el.style.height = '';
        }
    });
}


// --- Admin ---
function renderAdminSettings() {
    const s = state.settings || {};
    document.getElementById('setting-app-name').value = s.app_name || 'Gourmet Manager Pro';
    document.getElementById('setting-logo-icon').value = s.logo_icon || 'fa-utensils';
    document.getElementById('setting-primary-color').value = s.primary_color || '#4f46e5';
    document.getElementById('setting-accent-color').value = s.accent_color || '#ec4899';
    document.getElementById('setting-font-family').value = s.font_family || 'Inter';
    document.getElementById('setting-language').value = s.language || 'uz';
    const uploadInput = document.getElementById('setting-logo-upload');
    if(uploadInput) uploadInput.value = '';
}

document.getElementById('settings-form')?.addEventListener('submit', async function(e) {
    e.preventDefault();
    
    let logoVal = document.getElementById('setting-logo-icon').value;
    const fileInput = document.getElementById('setting-logo-upload');
    
    const save = async (finalLogo) => {
        const settings = {
            app_name: document.getElementById('setting-app-name').value,
            logo_icon: finalLogo,
            primary_color: document.getElementById('setting-primary-color').value,
            accent_color: document.getElementById('setting-accent-color').value,
            font_family: document.getElementById('setting-font-family').value,
            language: document.getElementById('setting-language').value
        };
        try {
            await fetch(`${API_BASE}/settings`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(settings) });
            showToast("Sozlamalar saqlandi", "success");
            await fetchData();
        } catch(err) {
            showToast("Xatolik", "error");
        }
    };

    if (fileInput && fileInput.files && fileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = function(evt) {
            save(evt.target.result);
        };
        reader.readAsDataURL(fileInput.files[0]);
    } else {
        save(logoVal);
    }
});
let adminDashboardDateFilterType = 'all';
let adminDashboardDateFilterValue = '';

window.filterAdminDashboardDate = function(type, value = '') {
    adminDashboardDateFilterType = type;
    adminDashboardDateFilterValue = value;
    
    // Update active button styling
    const filterContainer = document.getElementById('admin-dashboard-date-filters');
    if (filterContainer) {
        filterContainer.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        if (type === 'all') filterContainer.querySelector('[data-date="all"]').classList.add('active');
        if (type === 'exact-date') filterContainer.querySelector('#admin-dashboard-exact-date').classList.add('active');
        if (type === 'exact-month') filterContainer.querySelector('#admin-dashboard-exact-month').classList.add('active');
    }
    renderAdminDashboard(true);
};

function renderAdminDashboard(renderChartAnim) {
    renderAdminSettings();
    
    // Apply Date Filter for Orders
    let filteredOrders = state.orders;
    if (adminDashboardDateFilterType === 'exact-date' && adminDashboardDateFilterValue) {
        filteredOrders = filteredOrders.filter(o => {
            const d = new Date(o.timestamp);
            const localDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            return localDateStr === adminDashboardDateFilterValue;
        });
    } else if (adminDashboardDateFilterType === 'exact-month' && adminDashboardDateFilterValue) {
        filteredOrders = filteredOrders.filter(o => {
            const d = new Date(o.timestamp);
            const localMonthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            return localMonthStr === adminDashboardDateFilterValue;
        });
    }
    
    // Apply Date Filter for Salaries
    let filteredSalaries = state.salaries || [];
    if (adminDashboardDateFilterType === 'exact-date' && adminDashboardDateFilterValue) {
        filteredSalaries = filteredSalaries.filter(s => s.date === adminDashboardDateFilterValue);
    } else if (adminDashboardDateFilterType === 'exact-month' && adminDashboardDateFilterValue) {
        filteredSalaries = filteredSalaries.filter(s => s.date.startsWith(adminDashboardDateFilterValue));
    }
    
    const completedOrders = filteredOrders.filter(o => o.status === 'ready' || o.status === 'completed' || o.status === 'archived');
    const totalOrdersProfit = completedOrders.reduce((sum, o) => sum + o.total, 0);
    const totalSalariesGiven = filteredSalaries.reduce((sum, s) => sum + s.amount, 0);
    const profit = totalOrdersProfit - totalSalariesGiven;
    
    document.getElementById('admin-total-profit').textContent = `${profit.toFixed(2)} so'm`;
    document.getElementById('admin-total-orders').textContent = filteredOrders.length;
    
    // Update top quick action badges
    let quickReceiptTables = [...new Set(state.orders.filter(o => o.status !== 'cancelled' && o.status !== 'archived').map(o => o.table))].length;
    let quickAllCount = state.orders.filter(o => o.status !== 'cancelled').length;
    let quickSaboyCount = state.orders.filter(o => o.status !== 'cancelled' && (o.table || '').startsWith('Saboy-')).length;
    
    const bReceipt = document.getElementById('badge-quick-receipt');
    if (bReceipt) { bReceipt.textContent = quickReceiptTables; bReceipt.style.display = quickReceiptTables > 0 ? 'flex' : 'none'; }
    const bAll = document.getElementById('badge-quick-all');
    if (bAll) { bAll.textContent = quickAllCount; bAll.style.display = quickAllCount > 0 ? 'flex' : 'none'; }
    const bSaboy = document.getElementById('badge-quick-saboy');
    if (bSaboy) { bSaboy.textContent = quickSaboyCount; bSaboy.style.display = quickSaboyCount > 0 ? 'flex' : 'none'; }
    
    document.getElementById('admin-total-chefs').textContent = state.users.filter(u => u.role === 'chef').length;
    document.getElementById('admin-total-waiters').textContent = state.users.filter(u => u.role === 'waiter').length;
    document.getElementById('admin-total-menus').textContent = state.menu.length;

    if (renderChartAnim) renderChart(completedOrders);
    
    // Render dynamic filters for Admin Saboy New
    const adminFilterContainer = document.getElementById('admin-menu-filters');
    if (adminFilterContainer) {
        let html = `<button class="filter-btn ${currentCategory === 'all' ? 'active' : ''}" onclick="setWaiterCategory(this, 'all')">Hammasi</button>`;
        state.categories.forEach(c => {
            html += `<button class="filter-btn ${currentCategory === c.value ? 'active' : ''}" onclick="setWaiterCategory(this, '${c.value}')">${c.name}</button>`;
        });
        adminFilterContainer.innerHTML = html;
    }

    // Only re-render tables if they changed (simple optimization for polling)
    renderUsersTable(state.users.filter(u => u.role === 'chef'), 'admin-chefs-table');
    renderUsersTable(state.users.filter(u => u.role === 'waiter'), 'admin-waiters-table');
    renderAdminMenuGrid(state.menu);
    renderWaiterMenu(); // Update Admin Saboy ordering grid
    renderAdminCategories();
    renderAdminSalaryDashboard();
    if (typeof renderReceiptTables === 'function') renderReceiptTables();

    // Update Employee filter options in Orders View
    const employeeFilter = document.getElementById('admin-employee-filter');
    if (employeeFilter) {
        const currentVal = employeeFilter.value;
        let optionsHtml = '<option value="all">Barcha Xodimlar (Oshpaz va Ofitsiantlar)</option>';
        state.users.filter(u => u.role !== 'admin').forEach(u => {
            optionsHtml += `<option value="${u.id}">${u.name} (${u.role === 'waiter' ? 'Ofitsiant' : 'Oshpaz'})</option>`;
        });
        employeeFilter.innerHTML = optionsHtml;
        employeeFilter.value = currentVal || 'all';
    }

    renderAdminOrders();
    renderAdminSaboyOrders();
    renderAdminInventory();
    renderExtendedStats();
    renderTopSellingProducts();
}

function renderChart(completedOrders) {
    const ctx = document.getElementById('profitChart');
    if (!ctx) return;
    const data = [0, 0, 0, 0, 0, 0, completedOrders.reduce((sum, o) => sum + o.total, 0)];
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Today'];

    if (profitChartInstance) profitChartInstance.destroy();
    profitChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: "Kunlik Foyda (so'm)", data: data, borderColor: '#4f46e5', backgroundColor: 'rgba(79, 70, 229, 0.1)', tension: 0.4, fill: true
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } }, x: { grid: { color: 'rgba(255,255,255,0.05)' } } }, plugins: { legend: { labels: { color: '#f8fafc' } } } }
    });
}

// ===== TOP SELLING PRODUCTS & EXTENDED STATS =====
let topProductsFilter = 'today';
let topProductsFilterValue = '';

function formatSom(amount) {
    return Number(amount).toLocaleString('uz-UZ', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " so'm";
}

function getDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getMonthStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function filterOrdersByDateRange(orders, filterType, filterValue) {
    const now = new Date();
    const todayStr = getDateStr(now);
    const thisMonthStr = getMonthStr(now);
    
    return orders.filter(o => {
        if (!o.timestamp) return false;
        const orderDate = new Date(o.timestamp);
        const orderDateStr = getDateStr(orderDate);
        const orderMonthStr = getMonthStr(orderDate);
        
        switch(filterType) {
            case 'today': return orderDateStr === todayStr;
            case 'all': return true;
            case 'exact-date': return orderDateStr === filterValue;
            case 'exact-month': return orderMonthStr === filterValue;
            default: return true;
        }
    });
}

function aggregateProductSales(orders) {
    const productMap = {};
    
    orders.forEach(order => {
        if (!order.items || !Array.isArray(order.items)) return;
        
        order.items.forEach(item => {
            const key = item.name || 'Noma\'lum';
            const qty = Number(item.qty) || 1;
            const price = Number(item.price) || 0;
            const totalForItem = price * qty;
            
            if (!productMap[key]) {
                productMap[key] = {
                    name: key,
                    icon: item.icon || '',
                    price: price,
                    totalQty: 0,
                    totalAmount: 0
                };
            }
            productMap[key].totalQty += qty;
            productMap[key].totalAmount += totalForItem;
            // Update price to latest if different
            if (price > 0) productMap[key].price = price;
            // Update icon if available
            if (item.icon) productMap[key].icon = item.icon;
        });
    });
    
    return Object.values(productMap).sort((a, b) => b.totalQty - a.totalQty);
}

function renderExtendedStats() {
    const now = new Date();
    const todayStr = getDateStr(now);
    const thisMonthStr = getMonthStr(now);
    
    const completedOrders = state.orders.filter(o => o.status === 'ready' || o.status === 'completed');
    
    // Today stats
    const todayOrders = completedOrders.filter(o => {
        if (!o.timestamp) return false;
        return getDateStr(new Date(o.timestamp)) === todayStr;
    });
    const todaySalesCount = todayOrders.length;
    const todayIncome = todayOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    
    // Monthly stats
    const monthOrders = completedOrders.filter(o => {
        if (!o.timestamp) return false;
        return getMonthStr(new Date(o.timestamp)) === thisMonthStr;
    });
    const monthlyIncome = monthOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    
    // Top product overall
    const allProducts = aggregateProductSales(completedOrders);
    const topProduct = allProducts.length > 0 ? allProducts[0].name : '—';
    
    // Update UI
    const elTodaySales = document.getElementById('stat-today-sales');
    const elTodayIncome = document.getElementById('stat-today-income');
    const elMonthlyIncome = document.getElementById('stat-monthly-income');
    const elTopProduct = document.getElementById('stat-top-product');
    
    if (elTodaySales) elTodaySales.textContent = todaySalesCount + ' ta';
    if (elTodayIncome) elTodayIncome.textContent = formatSom(todayIncome);
    if (elMonthlyIncome) elMonthlyIncome.textContent = formatSom(monthlyIncome);
    if (elTopProduct) elTopProduct.textContent = topProduct;
}

window.filterTopProducts = function(filterType, filterValue) {
    topProductsFilter = filterType;
    topProductsFilterValue = filterValue || '';
    
    // Update filter buttons active state
    const filterContainer = document.getElementById('top-products-filters');
    if (filterContainer) {
        filterContainer.querySelectorAll('.filter-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.filter === filterType) btn.classList.add('active');
        });
        // For date/month inputs, remove active from buttons
        if (filterType === 'exact-date' || filterType === 'exact-month') {
            filterContainer.querySelectorAll('button.filter-btn').forEach(btn => btn.classList.remove('active'));
        }
    }
    
    renderTopSellingProducts();
};

function renderTopSellingProducts() {
    const body = document.getElementById('top-products-body');
    const summaryRow = document.getElementById('top-summary-row');
    if (!body) return;
    
    const completedOrders = state.orders.filter(o => o.status === 'ready' || o.status === 'completed');
    const filteredOrders = filterOrdersByDateRange(completedOrders, topProductsFilter, topProductsFilterValue);
    const products = aggregateProductSales(filteredOrders);
    
    // Summary row
    const totalProducts = products.length;
    const totalItemsSold = products.reduce((s, p) => s + p.totalQty, 0);
    const totalRevenue = products.reduce((s, p) => s + p.totalAmount, 0);
    const totalOrders = filteredOrders.length;
    
    // Filter label
    let filterLabel = 'Bugun';
    if (topProductsFilter === 'all') filterLabel = 'Umumiy (barcha vaqt)';
    else if (topProductsFilter === 'exact-date') filterLabel = topProductsFilterValue || 'Tanlangan sana';
    else if (topProductsFilter === 'exact-month') filterLabel = topProductsFilterValue || 'Tanlangan oy';
    
    if (summaryRow) {
        summaryRow.innerHTML = `
            <div class="top-summary-item">
                <i class="fas fa-filter" style="color: var(--primary-color);"></i>
                <span>${filterLabel}</span>
            </div>
            <div class="top-summary-item">
                <i class="fas fa-receipt" style="color: var(--primary-color);"></i>
                <span>Zakazlar: </span>
                <span class="summary-val" style="color: var(--primary-color);">${totalOrders} ta</span>
            </div>
            <div class="top-summary-item">
                <i class="fas fa-boxes" style="color: var(--warning-color);"></i>
                <span>Mahsulotlar: </span>
                <span class="summary-val" style="color: var(--warning-color);">${totalItemsSold} ta</span>
            </div>
            <div class="top-summary-item">
                <i class="fas fa-money-bill-wave" style="color: var(--success-color);"></i>
                <span>Daromad: </span>
                <span class="summary-val" style="color: var(--success-color);">${formatSom(totalRevenue)}</span>
            </div>
        `;
    }
    
    if (products.length === 0) {
        body.innerHTML = `
            <div class="top-products-empty">
                <i class="fas fa-box-open"></i>
                <p>Bu davr uchun sotuvlar topilmadi</p>
            </div>
        `;
        return;
    }
    
    let tableHtml = `
        <table class="top-products-table">
            <thead>
                <tr>
                    <th style="width: 40px;">#</th>
                    <th>Mahsulot</th>
                    <th>Narxi</th>
                    <th>Sotilgan</th>
                    <th>Umumiy Summa</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    products.forEach((product, index) => {
        const rank = index + 1;
        let medalClass = 'medal-default';
        let rowClass = '';
        if (rank === 1) { medalClass = 'medal-gold'; rowClass = 'top-row-1'; }
        else if (rank === 2) { medalClass = 'medal-silver'; rowClass = 'top-row-2'; }
        else if (rank === 3) { medalClass = 'medal-bronze'; rowClass = 'top-row-3'; }
        
        const imgHtml = product.icon && product.icon.startsWith('http')
            ? `<img src="${product.icon}" class="product-thumb" alt="${product.name}" onerror="this.style.display='none'">`
            : `<div class="product-thumb" style="display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.04);font-size:0.8rem;color:var(--text-secondary);"><i class="fas fa-utensils"></i></div>`;
        
        // Color for qty badge
        let qtyBg = 'rgba(0,0,0,0.06)';
        let qtyColor = 'var(--text-primary)';
        if (rank === 1) { qtyBg = 'rgba(245,158,11,0.15)'; qtyColor = '#b45309'; }
        else if (rank === 2) { qtyBg = 'rgba(148,163,184,0.15)'; qtyColor = '#475569'; }
        else if (rank === 3) { qtyBg = 'rgba(180,83,9,0.12)'; qtyColor = '#92400e'; }
        
        tableHtml += `
            <tr class="${rowClass}">
                <td><span class="medal-badge ${medalClass}">${rank}</span></td>
                <td>
                    <div class="product-name-cell">
                        ${imgHtml}
                        <span class="product-name-text">${product.name}</span>
                    </div>
                </td>
                <td>${formatSom(product.price)}</td>
                <td>
                    <span class="product-qty-badge" style="background:${qtyBg}; color:${qtyColor};">
                        <i class="fas fa-chart-bar" style="font-size:0.7rem;"></i>
                        ${product.totalQty} ta
                    </span>
                </td>
                <td><span class="product-total-amount">${formatSom(product.totalAmount)}</span></td>
            </tr>
        `;
    });
    
    tableHtml += '</tbody></table>';
    body.innerHTML = tableHtml;
}

function renderDailySales() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let totalRevenue = 0;
    let totalItemsCount = 0;
    const itemSales = {};

    state.orders.forEach(order => {
        if (order.status !== 'completed' && order.status !== 'ready' && order.status !== 'delivering' && order.status !== 'delivered' && order.status !== 'archived') return;
        
        const orderDate = new Date(order.timestamp);
        if (orderDate >= today) {
            order.items.forEach(item => {
                const qty = item.qty || 1;
                const price = item.price || 0;
                const revenue = qty * price;
                
                totalRevenue += revenue;
                totalItemsCount += qty;

                const name = item.name;
                if (!itemSales[name]) {
                    itemSales[name] = { qty: 0, revenue: 0 };
                }
                itemSales[name].qty += qty;
                itemSales[name].revenue += revenue;
            });
        }
    });

    const salesArray = Object.keys(itemSales).map(name => ({
        name: name,
        qty: itemSales[name].qty,
        revenue: itemSales[name].revenue
    }));

    // Sort by quantity descending
    salesArray.sort((a, b) => b.qty - a.qty);

    // Update summary cards
    document.getElementById('daily-total-revenue').textContent = totalRevenue.toLocaleString() + " so'm";
    document.getElementById('daily-total-items-sold').textContent = totalItemsCount;

    // Top 3 sellers
    const topSellersContainer = document.getElementById('daily-top-sellers-container');
    topSellersContainer.innerHTML = '';
    
    if (salesArray.length === 0) {
        topSellersContainer.innerHTML = '<div style="color: var(--text-secondary); padding: 1rem; text-align: center;">Hali hech qanday mahsulot sotilmadi</div>';
    } else {
        salesArray.slice(0, 3).forEach((item, index) => {
            const medals = ['🥇', '🥈', '🥉'];
            topSellersContainer.innerHTML += `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 1rem; background: var(--bg-color); border-radius: var(--radius-md); margin-bottom: 0.5rem;">
                    <div style="display: flex; align-items: center; gap: 1rem;">
                        <span style="font-size: 1.5rem;">${medals[index]}</span>
                        <div>
                            <div style="font-weight: bold; color: var(--text-color);">${item.name}</div>
                            <div style="font-size: 0.85rem; color: var(--text-secondary);">${item.qty} ta sotilgan</div>
                        </div>
                    </div>
                    <div style="font-weight: bold; color: var(--success-color);">
                        ${item.revenue.toLocaleString()} so'm
                    </div>
                </div>
            `;
        });
    }

    // All items table
    const tableBody = document.getElementById('daily-sales-table-body');
    tableBody.innerHTML = '';
    
    if (salesArray.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-secondary);">Bugun hali savdo bo\'lmadi</td></tr>';
    } else {
        salesArray.forEach(item => {
            tableBody.innerHTML += `
                <tr>
                    <td>${item.name}</td>
                    <td style="text-align: center; font-weight: bold;">${item.qty}</td>
                    <td style="text-align: right; color: var(--success-color); font-weight: 500;">${item.revenue.toLocaleString()}</td>
                </tr>
            `;
        });
    }
}

function renderAdminCategories() {
    const tbody = document.getElementById('admin-categories-table');
    if (!tbody) return;
    tbody.innerHTML = '';
    state.categories.forEach(c => {
        tbody.innerHTML += `
            <tr>
                <td><strong>${c.name}</strong></td>
                <td><span class="badge" style="text-transform:none;">${c.value}</span></td>
                <td>
                    <button class="btn icon-btn text-warning" onclick="event.stopPropagation(); editCategory('${c.id}')" title="Tahrirlash"><i class="fas fa-edit"></i></button>
                    <button class="btn icon-btn text-danger" onclick="event.stopPropagation(); deleteCategory('${c.id}')" title="O'chirish"><i class="fas fa-trash"></i></button>
                </td>
            </tr>`;
    });
}

function renderUsersTable(usersList, tableId) {
    const tbody = document.getElementById(tableId);
    if (!tbody) return;
    tbody.innerHTML = '';
    usersList.forEach(u => {
        let userOrders = [];
        if (u.role === 'waiter') userOrders = state.orders.filter(o => String(o.waiterId) === String(u.login));
        else if (u.role === 'chef') userOrders = state.orders.filter(o => String(o.chefId) === String(u.id) && (o.status === 'ready' || o.status === 'completed'));
        
        let totalIncome = userOrders.reduce((sum, o) => sum + o.total, 0);
        let count = userOrders.length;
        
        tbody.innerHTML += `
            <tr>
                <td onclick="viewUserStats('${u.id}')" style="cursor:pointer; color:var(--primary-color); font-weight:bold;">${u.name}</td>
                <td>${u.phone}</td>
                <td>${u.login}</td>
                <td>***</td>
                <td><span style="color:var(--text-secondary);">${count} ta</span> / <strong style="color:var(--success-color);">${totalIncome.toFixed(2)} so'm</strong></td>
                <td>
                    <button class="btn icon-btn text-primary" onclick="event.stopPropagation(); viewUserStats('${u.id}')" title="Statistikani ko'rish"><i class="fas fa-eye"></i></button>
                    <button class="btn icon-btn text-warning" onclick="event.stopPropagation(); editUser('${u.id}')" title="Tahrirlash"><i class="fas fa-edit"></i></button>
                    <button class="btn icon-btn text-danger" onclick="event.stopPropagation(); deleteUser('${u.id}')" title="O'chirish"><i class="fas fa-trash"></i></button>
                </td>
            </tr>`;
    });
}

function renderAdminMenuGrid(menuList) {
    const container = document.getElementById('admin-menus-grid');
    if (!container) return;
    
    const filterSelect = document.getElementById('admin-menu-category-filter');
    if (filterSelect && filterSelect.options.length <= 1 && state.categories.length > 0) {
        state.categories.forEach(c => {
            let opt = document.createElement('option');
            opt.value = c.value;
            opt.textContent = c.name;
            filterSelect.appendChild(opt);
        });
    }
    const filterCat = filterSelect ? filterSelect.value : 'all';
    
    let filteredMenu = menuList;
    if (filterCat !== 'all') {
        filteredMenu = menuList.filter(m => m.category === filterCat);
    }
    
    // Ichimliklarni tartib bo'yicha saralash: Coca-Cola → Pepsi → Fanta → Suv → Energetik → Fusetea
    const drinkBrandOrder = {'coca-cola': 1, 'coca cola': 1, 'pepsi': 2, 'fanta': 3, 'oddiy suv': 4, 'suv': 4, 'flesh': 5, 'gorilla': 6, 'adrenaline': 7, 'fusetea': 8};
    const sizeOrderMap = {'0.5': 1, '1': 2, '1.5': 3, '2': 4};
    filteredMenu.sort((a, b) => {
        if (a.category === 'ichimlik' && b.category === 'ichimlik') {
            let aName = (a.name || '').toLowerCase();
            let bName = (b.name || '').toLowerCase();
            let aBrand = 99, bBrand = 99;
            for (let key in drinkBrandOrder) {
                if (aName.includes(key)) { aBrand = drinkBrandOrder[key]; break; }
            }
            for (let key in drinkBrandOrder) {
                if (bName.includes(key)) { bBrand = drinkBrandOrder[key]; break; }
            }
            if (aBrand !== bBrand) return aBrand - bBrand;
            // Hajm bo'yicha saralash
            let aSize = (aName.match(/(\d+\.?\d*)\s*l/i) || [0, '99'])[1];
            let bSize = (bName.match(/(\d+\.?\d*)\s*l/i) || [0, '99'])[1];
            return parseFloat(aSize) - parseFloat(bSize);
        }
        return (a.id || 0) - (b.id || 0);
    });
    
    container.innerHTML = '';
    let adminHtmlContent = '';
    filteredMenu.forEach(m => {
        let iconHtml = (m.icon && m.icon.trim() !== '' && m.icon !== 'fa-fish' && m.icon !== 'fa-box') ? `<img src="${m.icon}" onerror="this.outerHTML='<i class=\'fas ${m.unit === 'kg' ? 'fa-fish' : 'fa-box'}\'></i>'">` : `<i class="fas ${m.unit === 'kg' ? 'fa-fish' : 'fa-box'}"></i>`;
        let catObj = state.categories.find(c => c.value === m.category);
        let catName = catObj ? catObj.name : m.category;
        let unitLabel = m.unit || 'dona';
        let qtyColor = m.quantity > 0 ? 'var(--text-secondary)' : 'var(--danger-color)';
        let qtyDisplay = `<div style="font-size:0.85rem; color:${qtyColor}; margin-top:0.3rem;"><i class="fas fa-boxes"></i> Qoldiq: ${m.quantity || 0} ${unitLabel}</div>`;
        
        let badgeBg = '#8b5cf6';
        let badgeIcon = 'fa-cube';
        let badgeText = unitLabel.charAt(0).toUpperCase() + unitLabel.slice(1);
        if (m.unit === 'kg' || m.unit === 'gramm') {
            badgeBg = '#3b82f6';
            badgeIcon = 'fa-weight-hanging';
            if (m.unit === 'kg') badgeText = 'kg (Baliq)';
        } else if (m.unit === 'litr' || m.unit === 'ml') {
            badgeBg = '#0ea5e9';
            badgeIcon = 'fa-tint';
        }
        
        let typeBadge = `<span style="background:${badgeBg}; color:white; padding:0.2rem 0.6rem; border-radius:20px; font-size:0.7rem; font-weight:600; display:inline-block; margin-top:0.3rem;"><i class="fas ${badgeIcon}"></i> ${badgeText}</span>`;
        
        let isInactive = m.active === 0;
        let inactiveBadge = isInactive ? `<span style="background:var(--danger-color); color:white; padding:0.2rem 0.6rem; border-radius:20px; font-size:0.7rem; font-weight:600; display:inline-block; margin-top:0.3rem;"><i class="fas fa-eye-slash"></i> Yashirilgan</span>` : '';
        let toggleBtnLabel = isInactive ? '<i class="fas fa-eye"></i> Ko\'rsatish' : '<i class="fas fa-eye-slash"></i> Yashirish';
        let toggleBtnClass = isInactive ? 'success-btn' : 'secondary-btn';
        let priceLabel = m.unit === 'kg' ? `${m.price.toFixed(0)} so'm/kg` : `${m.price.toFixed(0)} so'm`;
        adminHtmlContent += `
            <div class="menu-item" onclick="editMenu('${m.id}')" style="cursor:pointer; ${isInactive ? 'opacity:0.5; border: 2px dashed var(--danger-color);' : ''}">
                <div class="menu-item-icon">${iconHtml}</div>
                <h4>${m.name}</h4><div class="price">${priceLabel}</div>
                ${typeBadge}
                ${inactiveBadge}
                ${qtyDisplay}
                <span class="badge" style="margin-top:0.5rem; text-transform:capitalize;">${catName}</span>
                <button class="btn ${toggleBtnClass}" style="margin-top:0.5rem; padding:0.3rem 0.7rem; font-size:0.75rem; width:100%;" onclick="event.stopPropagation(); toggleMenuActive('${m.id}')">${toggleBtnLabel}</button>
            </div>`;
    });
    container.innerHTML = adminHtmlContent;
}

function renderAdminOrders() {
    const container = document.getElementById('admin-orders-container');
    if (!container) return;
    container.innerHTML = '';
    
    const employeeFilter = document.getElementById('admin-employee-filter');
    const selectedEmployeeId = employeeFilter ? employeeFilter.value : 'all';

    let filteredOrders = state.orders;
    
    if (adminOrdersCategory === 'saboy') {
        filteredOrders = filteredOrders.filter(o => o.table.startsWith('Saboy-'));
    } else if (adminOrdersCategory !== 'all') {
        filteredOrders = filteredOrders.filter(o => o.status === adminOrdersCategory);
    }
    
    if (selectedEmployeeId !== 'all') {
        filteredOrders = filteredOrders.filter(o => 
            String(o.waiterId) === String(selectedEmployeeId) || 
            String(o.chefId) === String(selectedEmployeeId)
        );
    }
    
    filteredOrders.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    if (filteredOrders.length === 0) {
        container.innerHTML = '<p class="text-secondary" style="grid-column: 1/-1; text-align: center;">Zakazlar topilmadi.</p>';
        return;
    }
    
    filteredOrders.forEach(order => {
        const waiter = state.users.find(u => u.login === order.waiterId) || {name: 'Noma\'lum'};
        const chef = state.users.find(u => u.id === order.chefId);
        const chefName = chef ? chef.name : 'Taqsimlanmagan';
        let statusBadge = '';
        if (order.status === 'pending') statusBadge = '<span class="badge" style="background: var(--warning-color)">Yangi</span>';
        else if (order.status === 'preparing') statusBadge = '<span class="badge" style="background: var(--primary-color)">Tayyorlanmoqda</span>';
        else if (order.status === 'ready') statusBadge = '<span class="badge" style="background: var(--warning-color); border: 1px solid currentColor;">Tayyor (Eltib berilmagan)</span>';
        else if (order.status === 'delivering') statusBadge = '<span class="badge" style="background: #f59e0b; color: white;">Olib borilmoqda</span>';
        else if (order.status === 'completed') statusBadge = '<span class="badge" style="background: var(--success-color)">Tasdiqlangan (Berilgan)</span>';
        else if (order.status === 'cancelled') statusBadge = '<span class="badge" style="background: var(--danger-color)">Bekor qilingan</span>';
        
        let itemsHtml = order.items.map(i => `<li>${i.qty}x ${i.name}</li>`).join('');
        const isSaboy = order.table.startsWith('Saboy-');
        let tableDisplay = isSaboy ? `📦 Saboy (${order.table.split('-')[1]})` : `Stol ${order.table}`;
        
        let timeDisplay = '';
        if (order.status === 'ready' && order.completedAt) {
            let start = new Date(order.timestamp);
            let end = new Date(order.completedAt);
            let diffMins = Math.round((end - start) / 60000);
            timeDisplay = `<span style="display:block; margin-top:0.25rem; font-size:0.85rem; color:var(--text-secondary)"><i class="fas fa-stopwatch"></i> Tayyorlanish: ${diffMins} daqiqa</span>`;
        }
        
        // Delivered by info
        let deliveredByDisplay = '';
        if (order.deliveredBy) {
            let deliverUser = state.users.find(u => u.login === order.deliveredBy);
            let deliverName = deliverUser ? deliverUser.name : order.deliveredBy;
            if (order.status === 'delivering') {
                deliveredByDisplay = `<span style="display:block; margin-top:0.25rem; font-size:0.85rem; color:#f59e0b; font-weight:600;"><i class="fas fa-running"></i> Olib boryapti: ${deliverName}</span>`;
            } else if (order.status === 'completed') {
                deliveredByDisplay = `<span style="display:block; margin-top:0.25rem; font-size:0.85rem; color:var(--success-color);"><i class="fas fa-check-circle"></i> Yetkazdi: ${deliverName}</span>`;
            }
        }
        
        container.innerHTML += `
            <div class="order-card" style="${isSaboy ? 'border: 2px solid var(--primary-color);' : ''}">
                <div class="order-header"><h3 style="${isSaboy ? 'color: var(--primary-color);' : ''}">${tableDisplay}</h3>${statusBadge}</div>
                <div class="order-meta">
                    <span><i class="fas fa-user-tie"></i> Ofitsiant: ${waiter.name}</span>
                    <span><i class="fas fa-fire"></i> Oshpaz: ${chefName}</span>
                    <span><i class="fas fa-clock"></i> ${new Date(order.timestamp).toLocaleString()}</span>
                </div>
                ${timeDisplay}
                ${deliveredByDisplay}
                <ul class="order-items-list" style="margin-top:0.5rem; max-height:100px; overflow-y:auto;">${itemsHtml}</ul>
                <div style="margin-top:auto; border-top:1px solid var(--border-color); padding-top:0.5rem; display:flex; flex-direction:column; gap:0.5rem;">
                    <div style="display:flex; justify-content:space-between; align-items:center; font-weight:bold;">
                        <span>Umumiy: ${order.total.toFixed(2)} so'm</span>
                    </div>
                    <div style="display:flex; gap:0.5rem;">
                        ${!isSaboy ? `<button class="btn secondary-btn" style="flex:1; font-size:0.85rem; padding:0.4rem;" onclick="event.stopPropagation(); changeOrderTable('${order.id}', '${order.table}')"><i class="fas fa-exchange-alt"></i> Joyni o'zgartirish</button>` : ''}
                        <button class="btn warning-btn" style="flex:1; font-size:0.85rem; padding:0.4rem;" onclick="event.stopPropagation(); startEditingOrder('${order.id}')"><i class="fas fa-edit"></i> Tahrirlash</button>
                        <button class="btn danger-btn" style="flex:1; font-size:0.85rem; padding:0.4rem;" onclick="event.stopPropagation(); deleteOrderPermanently('${order.id}')"><i class="fas fa-trash"></i> Bekor qilish</button>
                    </div>
                </div>
            </div>`;
    });
}

function renderAdminSaboyOrders() {
    const container = document.getElementById('admin-saboy-container');
    if (!container) return;
    container.innerHTML = '';
    
    let filteredOrders = state.orders.filter(o => o.table.startsWith('Saboy-') && o.status !== 'archived');
    
    if (adminSaboyCategory !== 'all') {
        filteredOrders = filteredOrders.filter(o => o.status === adminSaboyCategory);
    }
    
    filteredOrders.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    if (filteredOrders.length === 0) {
        container.innerHTML = '<p class="text-secondary" style="grid-column: 1/-1; text-align: center;">Saboy zakazlari topilmadi.</p>';
        return;
    }
    
    filteredOrders.forEach(order => {
        const waiter = state.users.find(u => u.login === order.waiterId) || {name: 'Noma\'lum'};
        const chef = state.users.find(u => u.id === order.chefId);
        const chefName = chef ? chef.name : 'Taqsimlanmagan';
        let statusBadge = '';
        if (order.status === 'pending') statusBadge = '<span class="badge" style="background: var(--warning-color)">Yangi</span>';
        else if (order.status === 'preparing') statusBadge = '<span class="badge" style="background: var(--primary-color)">Tayyorlanmoqda</span>';
        else if (order.status === 'ready') statusBadge = '<span class="badge" style="background: var(--success-color)">Tayyor</span>';
        else if (order.status === 'cancelled') statusBadge = '<span class="badge" style="background: var(--danger-color)">Bekor qilingan</span>';
        
        let itemsHtml = order.items.map(i => `<li>${i.qty}x ${i.name}</li>`).join('');
        let tableDisplay = `📦 Saboy (${order.table.split('-')[1] || order.table})`;
        
        let timeDisplay = '';
        if (order.completedAt) {
            let start = new Date(order.timestamp);
            let end = new Date(order.completedAt);
            let diffMins = Math.round((end - start) / 60000);
            timeDisplay = `<span style="display:block; margin-top:0.25rem; font-size:0.85rem; color:var(--text-secondary)"><i class="fas fa-stopwatch"></i> Tayyorlanish: ${diffMins} daqiqa</span>`;
        }
        
        container.innerHTML += `
            <div class="order-card" style="border: 2px solid var(--primary-color);">
                <div class="order-header"><h3 style="color: var(--primary-color);">${tableDisplay}</h3>${statusBadge}</div>
                <div class="order-meta">
                    <span><i class="fas fa-user-tie"></i> Ofitsiant: ${waiter.name}</span>
                    <span><i class="fas fa-fire"></i> Oshpaz: ${chefName}</span>
                    <span><i class="fas fa-clock"></i> ${new Date(order.timestamp).toLocaleString()}</span>
                </div>
                ${timeDisplay}
                <ul class="order-items-list" style="margin-top:0.5rem; max-height:100px; overflow-y:auto;">${itemsHtml}</ul>
                <div style="margin-top:auto; border-top:1px solid var(--border-color); padding-top:0.5rem; display:flex; flex-direction:column; gap:0.5rem;">
                    <div style="display:flex; justify-content:space-between; align-items:center; font-weight:bold;">
                        <span>Umumiy: ${order.total.toFixed(2)} so'm</span>
                    </div>
                    <div style="display:flex; gap:0.5rem;">
                        <button class="btn warning-btn" style="flex:1; font-size:0.85rem; padding:0.4rem;" onclick="event.stopPropagation(); startEditingOrder('${order.id}')"><i class="fas fa-edit"></i> Tahrirlash</button>
                        <button class="btn danger-btn" style="flex:1; font-size:0.85rem; padding:0.4rem;" onclick="event.stopPropagation(); deleteOrderPermanently('${order.id}')"><i class="fas fa-trash"></i> Bekor qilish</button>
                    </div>
                </div>
            </div>`;
    });
}

// --- Ombor (Inventory) Logic ---
let inventoryItems = [];
window.adminInventoryCurrentPage = 1;
const adminInventoryItemsPerPage = 10;

async function loadInventory() {
    try {
        const res = await fetch(`${API_BASE}/inventory`);
        if (res.ok) {
            inventoryItems = await res.json();
            renderAdminInventory();
            renderChefStore();
        }
    } catch (e) {
        console.error("Ombor yuklashda xato:", e);
    }
}

function renderAdminInventory() {
    const tbody = document.getElementById('admin-inventory-table');
    const lowAlert = document.getElementById('inventory-low-alert');
    const lowItemsContainer = document.getElementById('inventory-low-items');
    
    if (!tbody) return;
    tbody.innerHTML = '';
    
    let lowItems = [];
    
    // First, find all low items for the alert and stats (do this on all items, not just paginated)
    inventoryItems.forEach(m => {
        let qty = parseFloat(m.quantity || 0);
        let minAlert = parseFloat(m.min_alert || 0);
        if (qty <= minAlert && minAlert > 0) {
            lowItems.push(m);
        }
    });

    // Filtering by Search
    const searchInput = document.getElementById('admin-inventory-search');
    const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';
    
    let filteredItems = inventoryItems;
    if (searchQuery) {
        filteredItems = filteredItems.filter(m => m.name.toLowerCase().includes(searchQuery));
    }
    
    // Update Total Count Label
    const totalItemsEl = document.getElementById('admin-inventory-total-items');
    if (totalItemsEl) totalItemsEl.textContent = filteredItems.length;

    if (filteredItems.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding: 3rem; color: var(--text-secondary);">
            <i class="fas fa-search" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;"></i>
            <p>${searchQuery ? 'Hech narsa topilmadi' : 'Omborda mahsulot yo\'q. "Yangi Mahsulot" tugmasi orqali qo\'shing.'}</p>
        </td></tr>`;
        
        // Hide pagination
        document.getElementById('admin-inv-page-start').textContent = '0';
        document.getElementById('admin-inv-page-end').textContent = '0';
        document.getElementById('admin-inventory-pagination').innerHTML = '';
        if (lowAlert && !searchQuery) lowAlert.style.display = 'none';
    } else {
        // Pagination logic
        const totalPages = Math.ceil(filteredItems.length / adminInventoryItemsPerPage);
        if (window.adminInventoryCurrentPage > totalPages) window.adminInventoryCurrentPage = totalPages;
        if (window.adminInventoryCurrentPage < 1) window.adminInventoryCurrentPage = 1;
        
        const startIndex = (window.adminInventoryCurrentPage - 1) * adminInventoryItemsPerPage;
        const endIndex = Math.min(startIndex + adminInventoryItemsPerPage, filteredItems.length);
        const paginatedItems = filteredItems.slice(startIndex, endIndex);
        
        // Update pagination labels
        document.getElementById('admin-inv-page-start').textContent = startIndex + 1;
        document.getElementById('admin-inv-page-end').textContent = endIndex;
        
        // Render pagination buttons
        let paginationHtml = '';
        
        // Prev button
        paginationHtml += `<button class="btn" style="padding: 0.3rem 0.6rem; background: ${window.adminInventoryCurrentPage === 1 ? 'var(--bg-secondary)' : 'white'}; border: 1px solid var(--border-color); color: ${window.adminInventoryCurrentPage === 1 ? 'var(--text-secondary)' : 'var(--text-primary)'};" onclick="changeAdminInventoryPage(${window.adminInventoryCurrentPage - 1})" ${window.adminInventoryCurrentPage === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>`;
        
        // Page numbers
        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= window.adminInventoryCurrentPage - 1 && i <= window.adminInventoryCurrentPage + 1)) {
                let activeStyle = i === window.adminInventoryCurrentPage ? 'background: var(--primary-color); color: white; border: 1px solid var(--primary-color);' : 'background: white; border: 1px solid var(--border-color); color: var(--text-primary);';
                paginationHtml += `<button class="btn" style="padding: 0.3rem 0.8rem; font-weight: 600; ${activeStyle}" onclick="changeAdminInventoryPage(${i})">${i}</button>`;
            } else if (i === window.adminInventoryCurrentPage - 2 || i === window.adminInventoryCurrentPage + 2) {
                paginationHtml += `<span style="padding: 0.3rem 0.5rem; color: var(--text-secondary);">...</span>`;
            }
        }
        
        // Next button
        paginationHtml += `<button class="btn" style="padding: 0.3rem 0.6rem; background: ${window.adminInventoryCurrentPage === totalPages ? 'var(--bg-secondary)' : 'white'}; border: 1px solid var(--border-color); color: ${window.adminInventoryCurrentPage === totalPages ? 'var(--text-secondary)' : 'var(--text-primary)'};" onclick="changeAdminInventoryPage(${window.adminInventoryCurrentPage + 1})" ${window.adminInventoryCurrentPage === totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
        
        document.getElementById('admin-inventory-pagination').innerHTML = paginationHtml;
        
        paginatedItems.forEach(m => {
            let qty = parseFloat(m.quantity || 0);
            let minAlert = parseFloat(m.min_alert || 0);
            
            let unitLabel = m.unit === 'kg' ? 'kg' : (m.unit === 'litr' ? 'litr' : (m.unit === 'gramm' ? 'g' : 'dona'));
            let qtyDisplay = `${qty.toFixed(1)} <small>${unitLabel}</small>`;
            let priceDisplay = `<span style="font-weight: 600;">${parseFloat(m.price || 0).toLocaleString()}</span> <small style="color:var(--text-secondary);">so'm/${unitLabel}</small>`;
            let qtyColor = qty > minAlert ? 'var(--success-color)' : 'var(--danger-color)';
            let qtyBg = qty > minAlert ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
            
            let iconHtml = '';
            if (m.icon && (m.icon.includes('.jpg') || m.icon.includes('.png') || m.icon.includes('.jpeg') || m.icon.includes('http'))) {
                iconHtml = `<img src="${m.icon}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 9px;" onerror="this.outerHTML='📦'" />`;
            } else if (m.icon && m.icon.includes('fa-')) {
                iconHtml = `<i class="fas ${m.icon}"></i>`;
            } else {
                iconHtml = m.icon || '📦';
            }
            
            let typeBadge = '';
            if (m.unit === 'kg') typeBadge = '<span class="badge" style="background:rgba(59,130,246,0.1); color:#3b82f6; border:1px solid rgba(59,130,246,0.2);"><i class="fas fa-weight-hanging"></i> kg</span>';
            else if (m.unit === 'litr') typeBadge = '<span class="badge" style="background:rgba(14,165,233,0.1); color:#0ea5e9; border:1px solid rgba(14,165,233,0.2);"><i class="fas fa-tint"></i> litr</span>';
            else if (m.unit === 'gramm') typeBadge = '<span class="badge" style="background:rgba(99,102,241,0.1); color:#6366f1; border:1px solid rgba(99,102,241,0.2);"><i class="fas fa-balance-scale"></i> gramm</span>';
            else typeBadge = '<span class="badge" style="background:rgba(139,92,246,0.1); color:#8b5cf6; border:1px solid rgba(139,92,246,0.2);"><i class="fas fa-cube"></i> dona</span>';
            
            tbody.innerHTML += `
                <tr style="transition: all 0.2s; border-bottom: 1px solid var(--border-color);" onmouseenter="this.style.backgroundColor='var(--bg-secondary)'" onmouseleave="this.style.backgroundColor='transparent'">
                    <td style="min-width: 250px;">
                        <div style="display: flex; align-items: center; gap: 0.8rem;">
                            <div style="width: 40px; height: 40px; border-radius: 10px; background: white; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; box-shadow: 0 2px 4px rgba(0,0,0,0.05); border: 1px solid var(--border-color); flex-shrink: 0;">
                                ${iconHtml}
                            </div>
                            <strong style="color: var(--text-primary); font-size: 1.05rem; line-height: 1.3; white-space: normal;">${m.name}</strong>
                        </div>
                    </td>
                    <td>${typeBadge}</td>
                    <td>
                        <div style="background: ${qtyBg}; color: ${qtyColor}; display: inline-block; padding: 0.4rem 0.8rem; border-radius: 8px; font-weight: 700; font-size: 1rem; border: 1px solid ${qtyColor}40;">
                            ${qtyDisplay}
                        </div>
                    </td>
                    <td>${priceDisplay}</td>
                    <td style="color: var(--text-secondary);">${minAlert} ${unitLabel}</td>
                    <td>
                        <div style="display:flex; align-items:center; gap:0.5rem; background: var(--bg-secondary); padding: 0.3rem; border-radius: 8px;">
                            <input type="number" class="form-input" id="inv-add-${m.id}" placeholder="${unitLabel}" style="width:70px; margin-bottom:0; padding: 0.4rem; border: none; background: white; text-align: center; font-weight: 600;" step="0.1">
                            <button class="btn success-btn" onclick="addStockToInventory('${m.id}')" style="white-space:nowrap; padding: 0.4rem 0.8rem; border-radius: 6px;"><i class="fas fa-plus"></i> Qo'shish</button>
                        </div>
                    </td>
                    <td>
                        <div style="display:flex; gap:0.5rem;">
                            <button class="btn primary-btn" onclick="editInventoryItem('${m.id}')" title="Tahrirlash" style="padding: 0.5rem; width: 36px; height: 36px; border-radius: 8px;"><i class="fas fa-edit"></i></button>
                            <button class="btn danger-btn" onclick="deleteInventoryItem('${m.id}')" title="O'chirish" style="padding: 0.5rem; width: 36px; height: 36px; border-radius: 8px;"><i class="fas fa-trash"></i></button>
                        </div>
                    </td>
                </tr>
            `;
        });
    }
    
    // Kam qolganlar ogohlantirishi
    if (lowAlert && lowItemsContainer) {
        if (lowItems.length > 0) {
            lowAlert.style.display = 'block';
            lowItemsContainer.innerHTML = lowItems.map(item => `
                <span class="badge" style="background: var(--danger-color); font-size: 0.9rem;">
                    ${item.name}: ${item.quantity} ${item.unit} qoldi (Min: ${item.min_alert})
                </span>
            `).join('');
        } else {
            lowAlert.style.display = 'none';
        }
    }
    
    // Admin dashboard stat updates
    const countEl = document.getElementById('admin-inventory-count');
    if (countEl) countEl.textContent = inventoryItems.length;
    
    const lowBadge = document.getElementById('admin-inventory-low-badge');
    const lowCountEl = document.getElementById('admin-inventory-low-count');
    if (lowBadge && lowCountEl) {
        if (lowItems.length > 0) {
            lowBadge.style.display = 'inline';
            lowCountEl.textContent = lowItems.length;
        } else {
            lowBadge.style.display = 'none';
        }
    }
}

window.changeAdminInventoryPage = function(page) {
    window.adminInventoryCurrentPage = page;
    renderAdminInventory();
}

window.addStockToInventory = async function(id) {
    const input = document.getElementById(`inv-add-${id}`);
    if (!input) return;
    const addQty = parseFloat(input.value);
    
    if (isNaN(addQty) || addQty <= 0) {
        showToast('To\'g\'ri miqdor kiriting', 'warning');
        return;
    }
    
    try {
        const res = await fetch(`${API_BASE}/inventory/${id}/stock`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity: addQty })
        });
        
        if (res.ok) {
            input.value = '';
            showToast('Omborga muvaffaqiyatli qo\'shildi!', 'success');
            await loadInventory();
        }
    } catch (err) {
        console.error(err);
        showToast('Xatolik yuz berdi', 'danger');
    }
}

window.openInventoryAddModal = function() {
    document.getElementById('inventory-form').reset();
    document.getElementById('inv-edit-id').value = '';
    document.getElementById('inventory-modal-title').innerHTML = '<i class="fas fa-warehouse"></i> Yangi Ombor Mahsuloti';
    openModal('inventory-add-modal');
}

window.editInventoryItem = function(id) {
    const item = inventoryItems.find(m => m.id == id);
    if (!item) return;
    
    document.getElementById('inv-edit-id').value = item.id;
    document.getElementById('inv-name').value = item.name;
    document.getElementById('inv-unit').value = item.unit;
    document.getElementById('inv-quantity').value = item.quantity;
    document.getElementById('inv-price').value = item.price;
    document.getElementById('inv-min-alert').value = item.min_alert || 0;
    
    document.getElementById('inventory-modal-title').innerHTML = '<i class="fas fa-edit"></i> Omborni Tahrirlash';
    openModal('inventory-add-modal');
}

window.deleteInventoryItem = function(id) {
    if (!confirm('Rostdan ham bu mahsulotni ombordan o\'chirmoqchimisiz? Bu mahsulot ulangan barcha menyulardan ham o\'chib ketadi!')) return;
    
    // Optimistic UI
    inventoryItems = inventoryItems.filter(i => String(i.id) !== String(id));
    renderAdminInventory();
    
    try {
        fetch(`${API_BASE}/inventory/${id}`, { method: 'DELETE' }).then(res => {
            if (res.ok) showToast('Mahsulot o\'chirildi', 'success');
        });
    } catch (err) {
        console.error(err);
        showToast('Xatolik yuz berdi', 'danger');
    }
}

window.saveInventoryItem = async function(e) {
    e.preventDefault();
    const id = document.getElementById('inv-edit-id').value;
    const name = document.getElementById('inv-name').value;
    const unit = document.getElementById('inv-unit').value;
    const quantity = parseFloat(document.getElementById('inv-quantity').value || 0);
    const price = parseFloat(document.getElementById('inv-price').value || 0);
    const minAlert = parseFloat(document.getElementById('inv-min-alert').value || 0);
    
    const data = { name, unit, quantity, price, min_alert: minAlert };
    
    try {
        let url = `${API_BASE}/inventory`;
        let method = 'POST';
        
        if (id) {
            url = `${API_BASE}/inventory/${id}`;
            method = 'PUT';
        }
        
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        if (res.ok) {
            showToast('Ombor muvaffaqiyatli saqlandi', 'success');
            closeModal('inventory-add-modal');
            
            // Formni tozalash
            document.getElementById('inv-edit-id').value = '';
            document.getElementById('inventory-form').reset();
            document.getElementById('inventory-modal-title').innerHTML = '<i class="fas fa-warehouse"></i> Yangi Ombor Mahsuloti';
            
            await loadInventory();
        }
    } catch (err) {
        console.error(err);
        showToast('Xatolik yuz berdi', 'danger');
    }
}


// === OSHPAZ MAGAZIN (Store) ===
let pendingChefPurchase = null; // { inventoryId, quantity, itemName, unit }

function renderChefStore() {
    const grid = document.getElementById('chef-store-grid');
    if (!grid) return;
    grid.innerHTML = '';
    
    const searchInput = document.getElementById('chef-store-search');
    const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';
    
    let items = inventoryItems;
    if (searchQuery) {
        items = items.filter(m => m.name.toLowerCase().includes(searchQuery));
    }
    
    // Stats
    let totalItems = inventoryItems.length;
    let lowItems = [];
    let okItems = 0;
    
    inventoryItems.forEach(m => {
        let qty = parseFloat(m.quantity || 0);
        let minAlert = parseFloat(m.min_alert || 0);
        if (minAlert > 0 && qty <= minAlert) {
            lowItems.push(m);
        } else {
            okItems++;
        }
    });
    
    const elTotal = document.getElementById('chef-store-total');
    const elOk = document.getElementById('chef-store-ok');
    const elLow = document.getElementById('chef-store-low');
    if (elTotal) elTotal.textContent = totalItems;
    if (elOk) elOk.textContent = okItems;
    if (elLow) elLow.textContent = lowItems.length;
    
    // Badge on sidebar
    const badge = document.getElementById('chef-store-badge');
    if (badge) {
        if (lowItems.length > 0) {
            badge.textContent = lowItems.length;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }
    
    // Low stock alert
    const lowAlert = document.getElementById('chef-store-low-alert');
    const lowItemsContainer = document.getElementById('chef-store-low-items');
    if (lowAlert && lowItemsContainer) {
        if (lowItems.length > 0) {
            lowAlert.style.display = 'block';
            lowItemsContainer.innerHTML = lowItems.map(item => `
                <span class="badge" style="background: var(--danger-color); font-size: 0.85rem; padding: 0.3rem 0.6rem;">
                    ${item.name}: ${parseFloat(item.quantity).toFixed(1)} ${item.unit} qoldi (Min: ${item.min_alert})
                </span>
            `).join('');
        } else {
            lowAlert.style.display = 'none';
        }
    }
    
    if (items.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-secondary);">
            <i class="fas fa-search" style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;"></i>
            <p>${searchQuery ? 'Hech narsa topilmadi' : 'Omborda mahsulot yo\'q'}</p>
        </div>`;
        return;
    }
    
    items.forEach(m => {
        let qty = parseFloat(m.quantity || 0);
        let minAlert = parseFloat(m.min_alert || 0);
        let isLow = minAlert > 0 && qty <= minAlert;
        let isEmpty = qty <= 0;
        
        let unitLabel = m.unit || 'kg';
        
        // Icon based on unit type
        let icon = 'fa-cube';
        let iconColor = '#8b5cf6';
        if (m.unit === 'kg') { icon = 'fa-weight-hanging'; iconColor = '#3b82f6'; }
        else if (m.unit === 'gramm') { icon = 'fa-balance-scale'; iconColor = '#6366f1'; }
        else if (m.unit === 'litr') { icon = 'fa-tint'; iconColor = '#0ea5e9'; }
        else if (m.unit === 'ml') { icon = 'fa-flask'; iconColor = '#06b6d4'; }
        else if (m.unit === 'dona') { icon = 'fa-cube'; iconColor = '#8b5cf6'; }
        else if (m.unit === 'porsiya') { icon = 'fa-utensils'; iconColor = '#f59e0b'; }
        
        let statusColor = isEmpty ? '#ef4444' : (isLow ? '#f59e0b' : '#10b981');
        let statusText = isEmpty ? 'Tugagan' : (isLow ? 'Kam qolgan' : 'Mavjud');
        let statusIcon = isEmpty ? 'fa-times-circle' : (isLow ? 'fa-exclamation-triangle' : 'fa-check-circle');
        
        let borderStyle = isEmpty ? 'border: 2px solid #ef4444;' : (isLow ? 'border: 2px solid #f59e0b;' : 'border: 1px solid var(--border-color);');
        
        // Progress bar
        let maxQty = minAlert > 0 ? Math.max(qty, minAlert * 3) : Math.max(qty, 100);
        let progressPct = Math.min((qty / maxQty) * 100, 100);
        let progressColor = isEmpty ? '#ef4444' : (isLow ? '#f59e0b' : '#10b981');
        
        grid.innerHTML += `
            <div class="card" style="${borderStyle} padding: 0; overflow: hidden; transition: transform 0.2s, box-shadow 0.2s;" 
                 onmouseenter="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 8px 25px rgba(0,0,0,0.15)'"
                 onmouseleave="this.style.transform=''; this.style.boxShadow=''">
                
                <!-- Header -->
                <div style="background: linear-gradient(135deg, ${iconColor}15, ${iconColor}08); padding: 1rem 1rem 0.8rem; display: flex; align-items: center; gap: 0.8rem; border-bottom: 1px solid var(--border-color);">
                    <div style="width: 45px; height: 45px; border-radius: 12px; background: ${iconColor}; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                        <i class="fas ${icon}" style="color: white; font-size: 1.2rem;"></i>
                    </div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-weight: 700; font-size: 1rem; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${m.name}</div>
                        <div style="display: flex; align-items: center; gap: 0.4rem; margin-top: 0.15rem;">
                            <i class="fas ${statusIcon}" style="color: ${statusColor}; font-size: 0.75rem;"></i>
                            <span style="font-size: 0.75rem; color: ${statusColor}; font-weight: 600;">${statusText}</span>
                        </div>
                    </div>
                </div>
                
                <!-- Body -->
                <div style="padding: 1rem;">
                    <!-- Quantity display -->
                    <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.5rem;">
                        <span style="font-size: 0.8rem; color: var(--text-secondary);">Qoldiq:</span>
                        <span style="font-size: 1.4rem; font-weight: 800; color: ${statusColor};">${qty.toFixed(1)} <small style="font-size: 0.7rem; font-weight: 500;">${unitLabel}</small></span>
                    </div>
                    
                    <!-- Progress bar -->
                    <div style="height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden; margin-bottom: 1rem;">
                        <div style="height: 100%; width: ${progressPct}%; background: ${progressColor}; border-radius: 3px; transition: width 0.5s ease;"></div>
                    </div>
                    
                    <!-- Input + Button -->
                    ${isEmpty ? `
                        <div style="text-align: center; padding: 0.5rem; background: rgba(239,68,68,0.08); border-radius: 8px; color: var(--danger-color); font-weight: 600; font-size: 0.85rem;">
                            <i class="fas fa-ban"></i> Tugagan — admin xabardor
                        </div>
                    ` : `
                        <div style="display: flex; gap: 0.5rem; align-items: center;">
                            <input type="number" class="form-input" id="chef-buy-${m.id}" 
                                   placeholder="${unitLabel}" step="0.1" min="0.1" max="${qty}"
                                   style="margin-bottom: 0; flex: 1; text-align: center; font-weight: 600;">
                            <button class="btn primary-btn" onclick="chefBuyFromStore('${m.id}')" 
                                    style="white-space: nowrap; padding: 0.5rem 1rem;">
                                <i class="fas fa-shopping-cart"></i> Olish
                            </button>
                        </div>
                    `}
                </div>
            </div>
        `;
    });
}

window.chefBuyFromStore = function(id) {
    const input = document.getElementById(`chef-buy-${id}`);
    if (!input) return;
    const qty = parseFloat(input.value);
    
    if (isNaN(qty) || qty <= 0) {
        showToast('To\'g\'ri miqdor kiriting', 'warning');
        return;
    }
    
    const item = inventoryItems.find(m => m.id == id);
    if (!item) return;
    
    const available = parseFloat(item.quantity || 0);
    if (qty > available) {
        showToast(`Yetarli mahsulot yo'q! Mavjud: ${available.toFixed(1)} ${item.unit}`, 'danger');
        return;
    }
    
    // Save pending purchase and show confirmation
    pendingChefPurchase = {
        inventoryId: id,
        quantity: qty,
        itemName: item.name,
        unit: item.unit,
        available: available
    };
    
    const confirmBody = document.getElementById('chef-store-confirm-body');
    if (confirmBody) {
        const remaining = available - qty;
        const minAlert = parseFloat(item.min_alert || 0);
        let warningHtml = '';
        if (minAlert > 0 && remaining <= minAlert) {
            warningHtml = `<div style="background: rgba(245,158,11,0.1); border: 1px solid #f59e0b; border-radius: 8px; padding: 0.6rem; margin-top: 0.8rem; font-size: 0.85rem; color: #f59e0b;">
                <i class="fas fa-exclamation-triangle"></i> Ogohlantirish: Bu olishdan keyin qoldiq kam bo'ladi va adminga xabar yuboriladi!
            </div>`;
        }
        
        confirmBody.innerHTML = `
            <div style="background: var(--bg-secondary); border-radius: 12px; padding: 1rem;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                    <span style="color: var(--text-secondary);">Mahsulot:</span>
                    <strong>${item.name}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                    <span style="color: var(--text-secondary);">Hozirgi qoldiq:</span>
                    <span style="color: var(--success-color); font-weight: 600;">${available.toFixed(1)} ${item.unit}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                    <span style="color: var(--text-secondary);">Oladigan miqdor:</span>
                    <span style="color: var(--primary-color); font-weight: 700; font-size: 1.1rem;">- ${qty.toFixed(1)} ${item.unit}</span>
                </div>
                <hr style="border: none; border-top: 1px dashed var(--border-color); margin: 0.5rem 0;">
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--text-secondary);">Qoladi:</span>
                    <span style="color: ${remaining <= minAlert && minAlert > 0 ? 'var(--danger-color)' : 'var(--text-primary)'}; font-weight: 800; font-size: 1.2rem;">${remaining.toFixed(1)} ${item.unit}</span>
                </div>
            </div>
            ${warningHtml}
        `;
    }
    
    openModal('chef-store-confirm-modal');
}

window.confirmChefStorePurchase = async function() {
    if (!pendingChefPurchase) return;
    
    const { inventoryId, quantity, itemName, unit } = pendingChefPurchase;
    const chefName = currentUser ? currentUser.name : 'Oshpaz';
    
    try {
        const res = await fetch(`${API_BASE}/inventory/${inventoryId}/deduct`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity: quantity, chef_name: chefName })
        });
        
        const result = await res.json();
        
        if (res.ok && result.success) {
            closeModal('chef-store-confirm-modal');
            
            let msg = `✅ ${quantity.toFixed(1)} ${unit} ${itemName} olindi! Qoldiq: ${result.new_quantity.toFixed(1)} ${unit}`;
            showToast(msg, 'success');
            
            if (result.low_stock) {
                showToast(`⚠️ ${itemName} kam qoldi! Adminga xabar yuborildi`, 'warning');
            }
            
            // Clear input
            const input = document.getElementById(`chef-buy-${inventoryId}`);
            if (input) input.value = '';
            
            pendingChefPurchase = null;
            await loadInventory();
        } else {
            let errMsg = result.error || 'Xatolik yuz berdi';
            if (result.available !== undefined) {
                errMsg += ` (Mavjud: ${result.available} ${result.unit})`;
            }
            showToast(errMsg, 'danger');
        }
    } catch (err) {
        console.error(err);
        showToast('Server bilan bog\'lanishda xatolik', 'danger');
    }
}


// Salary Logic
let adminSalaryDateFilterType = 'all';
let adminSalaryDateFilterValue = null;

window.filterAdminSalaryDate = function(type, value = null) {
    adminSalaryDateFilterType = type;
    adminSalaryDateFilterValue = value;
    
    document.querySelectorAll('#admin-salary-date-filters .filter-btn').forEach(btn => btn.classList.remove('active'));
    
    if (type === 'all') {
        document.querySelector('#admin-salary-date-filters button[data-date="all"]').classList.add('active');
        if(document.getElementById('admin-salary-exact-date')) document.getElementById('admin-salary-exact-date').value = '';
        if(document.getElementById('admin-salary-exact-month')) document.getElementById('admin-salary-exact-month').value = '';
    } else if (type === 'exact-date') {
        document.getElementById('admin-salary-exact-date').classList.add('active');
        if(document.getElementById('admin-salary-exact-month')) document.getElementById('admin-salary-exact-month').value = '';
        document.querySelector('#admin-salary-date-filters button[data-date="all"]').classList.remove('active');
    } else if (type === 'exact-month') {
        document.getElementById('admin-salary-exact-month').classList.add('active');
        if(document.getElementById('admin-salary-exact-date')) document.getElementById('admin-salary-exact-date').value = '';
        document.querySelector('#admin-salary-date-filters button[data-date="all"]').classList.remove('active');
    }
    
    renderAdminSalaryDashboard();
};

function renderAdminSalaryDashboard() {
    const tbody = document.getElementById('admin-salary-table');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    const employees = state.users.filter(u => u.role === 'chef' || u.role === 'waiter');
    
    employees.forEach(u => {
        let userOrders = [];
        if (u.role === 'waiter') userOrders = state.orders.filter(o => String(o.waiterId) === String(u.login));
        else if (u.role === 'chef') userOrders = state.orders.filter(o => String(o.chefId) === String(u.id));
        
        let dateFilteredOrders = userOrders;
        if (adminSalaryDateFilterType === 'exact-date' && adminSalaryDateFilterValue) {
            dateFilteredOrders = userOrders.filter(o => {
                const d = new Date(o.timestamp);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === adminSalaryDateFilterValue;
            });
        } else if (adminSalaryDateFilterType === 'exact-month' && adminSalaryDateFilterValue) {
            dateFilteredOrders = userOrders.filter(o => {
                const d = new Date(o.timestamp);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === adminSalaryDateFilterValue;
            });
        }
        
        const completedOrders = dateFilteredOrders.filter(o => o.status === 'ready' || o.status === 'completed' || o.status === 'archived');
        
        // Find given salaries
        let userSalaries = state.salaries.filter(s => String(s.userId) === String(u.id));
        userSalaries.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        let lastSalaryTimestamp = userSalaries.length > 0 ? new Date(userSalaries[0].timestamp).getTime() : 0;
        
        const unpaidOrders = completedOrders.filter(o => {
            return new Date(o.timestamp).getTime() > lastSalaryTimestamp;
        });
        
        const totalEarnings = unpaidOrders.reduce((sum, o) => sum + o.total, 0);
        
        let filteredUserSalaries = userSalaries;
        if (adminSalaryDateFilterType === 'exact-date' && adminSalaryDateFilterValue) {
            filteredUserSalaries = userSalaries.filter(s => s.date === adminSalaryDateFilterValue);
        } else if (adminSalaryDateFilterType === 'exact-month' && adminSalaryDateFilterValue) {
            filteredUserSalaries = userSalaries.filter(s => s.date.startsWith(adminSalaryDateFilterValue));
        }
        const totalGiven = filteredUserSalaries.reduce((sum, s) => sum + s.amount, 0);
        
        tbody.innerHTML += `
            <tr>
                <td><strong>${u.name}</strong><br><small class="text-secondary">${u.phone}</small></td>
                <td><span class="badge">${u.role === 'chef' ? 'Oshpaz' : 'Ofitsiant'}</span></td>
                <td><strong style="color:var(--primary-color);">${totalEarnings.toFixed(2)} so'm</strong><br><small class="text-secondary">Savdo qilingan</small></td>
                <td><strong style="color:var(--success-color);">${totalGiven.toFixed(2)} so'm</strong></td>
                <td>
                    <button class="btn success-btn" onclick="openSalaryModal('${u.id}', ${totalEarnings}, '${u.name}')" ${totalEarnings <= 0 ? 'disabled' : ''}>
                        <i class="fas fa-money-bill-wave"></i> Oylik Berish
                    </button>
                </td>
            </tr>
        `;
    });
    
    // Render Admin Salary History Table
    const historyTbody = document.getElementById('admin-salary-history-table');
    if (historyTbody) {
        historyTbody.innerHTML = '';
        let allSalaries = [...state.salaries];
        
        // Filter history by date if selected
        if (adminSalaryDateFilterType === 'exact-date' && adminSalaryDateFilterValue) {
            allSalaries = allSalaries.filter(s => s.date === adminSalaryDateFilterValue);
        } else if (adminSalaryDateFilterType === 'exact-month' && adminSalaryDateFilterValue) {
            allSalaries = allSalaries.filter(s => s.date.startsWith(adminSalaryDateFilterValue));
        }
        
        allSalaries.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        if (allSalaries.length === 0) {
            historyTbody.innerHTML = '<tr><td colspan="6" class="text-secondary text-center">Tarix topilmadi.</td></tr>';
        } else {
            allSalaries.forEach(s => {
                const sUser = state.users.find(u => String(u.id) === String(s.userId));
                const sName = sUser ? sUser.name : 'Noma\'lum';
                const sRole = sUser ? (sUser.role === 'chef' ? 'Oshpaz' : 'Ofitsiant') : '';
                historyTbody.innerHTML += `
                    <tr>
                        <td>${new Date(s.timestamp).toLocaleString()}</td>
                        <td><strong>${sName}</strong></td>
                        <td><span class="badge" style="background:var(--secondary-color);">${sRole}</span></td>
                        <td style="color:var(--success-color); font-weight:bold;">${s.amount.toFixed(2)} so'm</td>
                        <td>${s.percentage}%</td>
                        <td>
                            <button class="btn danger-btn" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" onclick="deleteSalary('${s.id}')">
                                <i class="fas fa-trash"></i>
                            </button>
                        </td>
                    </tr>
                `;
            });
        }
    }
}

window.deleteSalary = async function(id) {
    if (!confirm("Haqiqatan ham bu oylik tarixini o'chirmoqchimisiz?")) return;
    try {
        const response = await fetch(`${API_BASE}/salaries/${id}`, { method: 'DELETE' });
        const res = await response.json();
        if (res.success) {
            showToast("Oylik tarixi o'chirildi", "success");
            // State will be refreshed automatically due to global poll or we can trigger it
            await fetchData();
            renderAdminSalaryDashboard();
        } else {
            showToast(res.error || "Xatolik yuz berdi", "danger");
        }
    } catch (e) {
        console.error(e);
        showToast("Xatolik yuz berdi", "danger");
    }
};

window.openSalaryModal = function(userId, totalAmount, userName) {
    document.getElementById('salary-user-id').value = userId;
    document.getElementById('salary-total-amount').value = totalAmount;
    document.getElementById('salary-percentage').value = '';
    document.getElementById('salary-calc-employee').textContent = "0.00 so'm";
    document.getElementById('salary-calc-admin').textContent = totalAmount.toFixed(2) + " so'm";
    document.getElementById('salary-modal-info').innerHTML = `<strong>${userName}</strong> uchun topilgan jami daromad: <strong style="color:var(--success-color);">${totalAmount.toFixed(2)} so'm</strong>. Qancha foiz oylik berasiz?`;
    document.getElementById('salary-modal').classList.add('active');
};

document.getElementById('salary-percentage')?.addEventListener('input', function(e) {
    let perc = parseFloat(e.target.value) || 0;
    if (perc > 100) perc = 100;
    if (perc < 0) perc = 0;
    const totalAmount = parseFloat(document.getElementById('salary-total-amount').value) || 0;
    const salary = (totalAmount * perc) / 100;
    const remain = totalAmount - salary;
    document.getElementById('salary-calc-employee').textContent = salary.toFixed(2) + " so'm";
    document.getElementById('salary-calc-admin').textContent = remain.toFixed(2) + " so'm";
});

document.getElementById('salary-form')?.addEventListener('submit', async function(e) {
    e.preventDefault();
    const userId = document.getElementById('salary-user-id').value;
    const totalAmount = parseFloat(document.getElementById('salary-total-amount').value) || 0;
    let perc = parseFloat(document.getElementById('salary-percentage').value) || 0;
    if (perc > 100) perc = 100;
    
    const amount = (totalAmount * perc) / 100;
    let dateStr = 'all';
    if (adminSalaryDateFilterType === 'exact-date' && adminSalaryDateFilterValue) dateStr = adminSalaryDateFilterValue;
    else if (adminSalaryDateFilterType === 'exact-month' && adminSalaryDateFilterValue) dateStr = adminSalaryDateFilterValue;
    else {
        const d = new Date();
        dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    const payload = {
        id: 'sal_' + Date.now(),
        userId: userId,
        amount: amount,
        percentage: perc,
        date: dateStr,
        timestamp: new Date().toISOString()
    };
    
    try {
        await fetch(`${API_BASE}/salaries`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
        showToast("Oylik muvaffaqiyatli berildi", "success");
        closeModal('salary-modal');
        await fetchData(); 
        updateDashboards('admin');
        renderAdminSalaryDashboard();
    } catch(e) {
        showToast("Xatolik yuz berdi", "danger");
    }
});

// User CRUD
function generateCredentials() {
    document.getElementById('staff-login').value = Math.floor(100 + Math.random() * 900).toString();
    document.getElementById('staff-password').value = Math.floor(100 + Math.random() * 900).toString();
}

document.getElementById('staff-form').addEventListener('submit', function(e) {
    e.preventDefault();
    const id = document.getElementById('staff-id').value;
    const user = {
        id: id ? parseInt(id) : Date.now(),
        role: document.getElementById('staff-role').value,
        name: document.getElementById('staff-name').value,
        phone: document.getElementById('staff-phone').value,
        login: document.getElementById('staff-login').value,
        password: document.getElementById('staff-password').value
    };
    
    // Optimistic UI
    const existingIdx = state.users.findIndex(u => String(u.id) === String(user.id));
    if (existingIdx > -1) state.users[existingIdx] = user;
    else state.users.push(user);
    
    closeModal('staff-modal');
    updateDashboards('admin');
    
    fetch(`${API_BASE}/users`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(user) }).then(res => {
        if(res.ok) showToast(id ? "Xodim yangilandi" : "Xodim qo'shildi", "success");
    });
});

window.editUser = function(id) {
    const user = state.users.find(u => String(u.id) === String(id));
    if (!user) return;
    document.getElementById('staff-id').value = user.id;
    document.getElementById('staff-role').value = user.role;
    document.getElementById('staff-name').value = user.name;
    document.getElementById('staff-phone').value = user.phone;
    document.getElementById('staff-login').value = user.login;
    document.getElementById('staff-password').value = user.password;
    document.getElementById('staff-modal-title').textContent = "Xodimni Tahrirlash";
    document.getElementById('staff-modal').classList.add('active');
};

window.deleteUser = function(id) {
    showConfirm("Haqiqatan ham ushbu xodimni o'chirasizmi?", () => {
        // Optimistic UI
        state.users = state.users.filter(u => String(u.id) !== String(id));
        updateDashboards('admin');
        
        fetch(`${API_BASE}/users/${id}`, { method: 'DELETE' }).then(() => {
            showToast("O'chirildi", "success");
        });
    });
};

let currentUserStatsId = null;
let currentStatsFilter = 'all';
let currentStatsDateFilterType = 'all';
let currentStatsDateFilterValue = null;

window.viewUserStats = function(id) {
    currentUserStatsId = id;
    const user = state.users.find(u => String(u.id) === String(id));
    if (!user) return;
    
    // Set basic info
    document.getElementById('stats-name').textContent = user.name;
    document.getElementById('stats-role').textContent = user.role === 'chef' ? 'Oshpaz' : 'Ofitsiant';
    document.getElementById('stats-phone-val').textContent = user.phone;
    document.getElementById('stats-login-val').textContent = user.login;
    document.getElementById('stats-password-val').textContent = user.password;
    
    const icon = document.getElementById('stats-avatar-icon');
    icon.className = user.role === 'chef' ? 'fas fa-fire' : 'fas fa-user-tie';

    // Reset filters visual state
    document.querySelectorAll('#stats-order-filters .filter-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector('#stats-order-filters .filter-btn[data-status="all"]').classList.add('active');
    currentStatsFilter = 'all';

    filterUserStatsDate('all');
    
    document.querySelectorAll('.admin-subview').forEach(el => el.classList.remove('active'));
    document.getElementById('admin-view-staff-stats').classList.add('active');
};

window.closeAdminStaffStats = function() {
    const role = document.getElementById('stats-role').textContent.toLowerCase();
    document.querySelectorAll('.admin-subview').forEach(el => el.classList.remove('active'));
    if (role === 'oshpaz' || role === 'chef') {
        document.getElementById('admin-view-chefs').classList.add('active');
    } else {
        document.getElementById('admin-view-waiters').classList.add('active');
    }
};

window.filterUserStatsDate = function(type, value = null) {
    currentStatsDateFilterType = type;
    currentStatsDateFilterValue = value;
    
    document.querySelectorAll('#stats-date-filters .filter-btn').forEach(btn => btn.classList.remove('active'));
    
    if (type === 'all') {
        document.querySelector('#stats-date-filters button[data-date="all"]').classList.add('active');
        if(document.getElementById('stats-exact-date')) document.getElementById('stats-exact-date').value = '';
        if(document.getElementById('stats-exact-month')) document.getElementById('stats-exact-month').value = '';
    } else if (type === 'exact-date') {
        document.getElementById('stats-exact-date').classList.add('active');
        if(document.getElementById('stats-exact-month')) document.getElementById('stats-exact-month').value = '';
        document.querySelector('#stats-date-filters button[data-date="all"]').classList.remove('active');
    } else if (type === 'exact-month') {
        document.getElementById('stats-exact-month').classList.add('active');
        if(document.getElementById('stats-exact-date')) document.getElementById('stats-exact-date').value = '';
        document.querySelector('#stats-date-filters button[data-date="all"]').classList.remove('active');
    }
    renderUserStatsOrders();
};


window.filterUserStatsOrders = function(status) {
    currentStatsFilter = status;
    document.querySelectorAll('#stats-order-filters .filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if(btn.dataset.status === status) btn.classList.add('active');
    });
    renderUserStatsOrders();
};

// Waiter Filters
let waiterCategoryFilter = 'all';

window.filterMenu = function(cat) {
    waiterCategoryFilter = cat;
    document.querySelectorAll('#waiter-menu-filters .filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.category === cat) btn.classList.add('active');
    });
    renderMenu();
};

let waiterMyDateFilterType = 'all';
let waiterMyDateFilterValue = null;
let waiterMyStatusFilter = 'all';

window.filterWaiterMyDate = function(type, value = null) {
    waiterMyDateFilterType = type;
    waiterMyDateFilterValue = value;
    
    document.querySelectorAll('#waiter-my-date-filters .filter-btn').forEach(btn => btn.classList.remove('active'));
    
    if (type === 'all') {
        document.querySelector('#waiter-my-date-filters button[data-date="all"]').classList.add('active');
        document.getElementById('waiter-my-exact-date').value = '';
        document.getElementById('waiter-my-exact-month').value = '';
    } else if (type === 'exact-date') {
        document.getElementById('waiter-my-exact-date').classList.add('active');
        document.getElementById('waiter-my-exact-month').value = '';
        document.querySelector('#waiter-my-date-filters button[data-date="all"]').classList.remove('active');
    } else if (type === 'exact-month') {
        document.getElementById('waiter-my-exact-month').classList.add('active');
        document.getElementById('waiter-my-exact-date').value = '';
        document.querySelector('#waiter-my-date-filters button[data-date="all"]').classList.remove('active');
    }
    
    renderWaiterMyOrders();
};

window.filterWaiterMyOrders = function(status) {
    waiterMyStatusFilter = status;
    document.querySelectorAll('#waiter-my-order-filters .filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if(btn.dataset.status === status) btn.classList.add('active');
    });
    renderWaiterMyOrders();
};

function renderWaiterMyOrders() {
    if (!currentUser || currentUser.role !== 'waiter') return;
    
    // Show: 
    // 1) Orders created by this waiter
    // 2) ALL orders that are 'ready' (Oshpaz tayyorlagan)
    // 3) Orders that are 'delivering' and accepted by this waiter
    let myOrders = state.orders.filter(o => 
        o.waiterId === currentUser.login || 
        o.status === 'ready' || 
        (o.status === 'delivering' && o.deliveredBy === currentUser.login)
    );
    
    // Yechilgan oylikdan oldingi zakazlarni yashirish
    let userSalaries = state.salaries.filter(s => String(s.userId) === String(currentUser.id));
    userSalaries.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    let lastSalaryTimestamp = userSalaries.length > 0 ? new Date(userSalaries[0].timestamp).getTime() : 0;
    
    myOrders = myOrders.filter(o => new Date(o.timestamp).getTime() > lastSalaryTimestamp);

    
    // Apply Date Filter
    let dateFilteredOrders = myOrders;
    
    if (waiterMyDateFilterType === 'exact-date' && waiterMyDateFilterValue) {
        dateFilteredOrders = myOrders.filter(o => {
            const d = new Date(o.timestamp);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const localDateStr = `${yyyy}-${mm}-${dd}`;
            return localDateStr === waiterMyDateFilterValue;
        });
    } else if (waiterMyDateFilterType === 'exact-month' && waiterMyDateFilterValue) {
        dateFilteredOrders = myOrders.filter(o => {
            const d = new Date(o.timestamp);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const localMonthStr = `${yyyy}-${mm}`;
            return localMonthStr === waiterMyDateFilterValue;
        });
    }

    // Total income calculation
    const completedOrders = dateFilteredOrders.filter(o => o.status === 'ready' || o.status === 'completed');
    const totalOrdersEl = document.getElementById('waiter-my-total-orders');
    const totalIncomeEl = document.getElementById('waiter-my-total-income');
    if(totalOrdersEl) totalOrdersEl.textContent = dateFilteredOrders.length;
    if(totalIncomeEl) totalIncomeEl.textContent = `${completedOrders.reduce((sum, o) => sum + o.total, 0).toFixed(2)} so'm`;

    let filteredOrders = dateFilteredOrders;
    if (waiterMyStatusFilter !== 'all') {
        filteredOrders = dateFilteredOrders.filter(o => o.status === waiterMyStatusFilter);
    }
    
    const container = document.getElementById('waiter-orders-container');
    if(container) {
        container.innerHTML = '';
        if(filteredOrders.length === 0) {
            container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); width: 100%; margin-top: 2rem;">Zakazlar mavjud emas.</p>';
        } else {
            filteredOrders.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
            filteredOrders.forEach(o => {
                let itemsHtml = o.items.map(i => `<b>${i.qty}x</b> ${i.name}`).join(', ');
                let statusColor = 'var(--primary-color)';
                let statusText = 'Yangi';
                if(o.status === 'ready') { statusColor = 'var(--success-color)'; statusText = 'Tayyor (Olib keting)'; }
                else if(o.status === 'delivering') { statusColor = '#8b5cf6'; statusText = 'Yetkazilmoqda'; }
                else if(o.status === 'cancelled') { statusColor = 'var(--danger-color)'; statusText = 'Bekor'; }
                else if(o.status === 'preparing') { statusColor = 'var(--warning-color)'; statusText = 'Jarayonda'; }
                else if(o.status === 'completed') { statusColor = 'var(--text-secondary)'; statusText = 'Yakunlandi'; }
                
                const isSaboy = o.table.startsWith('Saboy-');
                let tableDisplay = isSaboy ? `📦 Saboy (${o.table.split('-')[1]})` : `Stol ${o.table}`;
                
                let timeDisplay = '';
                if (o.status === 'ready' && o.completedAt) {
                    let start = new Date(o.timestamp);
                    let end = new Date(o.completedAt);
                    let diffMins = Math.round((end - start) / 60000);
                    timeDisplay = `<span style="display:inline-block; margin-left:1rem; color:var(--text-secondary); font-size:0.9rem;"><i class="fas fa-stopwatch"></i> Tayyorlanish: ${diffMins} daqiqa</span>`;
                }

                // Get names of the creator and the deliverer
                const creator = state.users.find(u => u.login === o.waiterId);
                const creatorName = creator ? creator.name : o.waiterId;
                const deliverer = o.deliveredBy ? state.users.find(u => u.login === o.deliveredBy) : null;
                const delivererName = deliverer ? deliverer.name : o.deliveredBy;

                let actionButtons = '';
                if (o.status === 'ready') {
                    actionButtons = `<button class="btn success-btn" style="width: 100%; margin-top: 1rem; font-size: 1.1rem; padding: 0.8rem;" onclick="acceptOrderForDelivery('${o.id}')"><i class="fas fa-hand-holding"></i> Qabul qildim (Olib ketish)</button>`;
                } else if (o.status === 'delivering' && o.deliveredBy === currentUser.login) {
                    actionButtons = `<button class="btn" style="width: 100%; margin-top: 1rem; font-size: 1.1rem; padding: 0.8rem; background: #8b5cf6; color: white;" onclick="deliverOrderToCustomer('${o.id}')"><i class="fas fa-check-circle"></i> Mijozga topshirdim</button>`;
                }
                
                let namesHtml = `<div style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 0.5rem;">Zakaz oluvchi: <b>${creatorName}</b>`;
                if (delivererName) {
                    namesHtml += ` | Yetkazuvchi: <b style="color: #8b5cf6;">${delivererName}</b>`;
                }
                namesHtml += `</div>`;

                container.innerHTML += `
                    <div style="background: white; padding: 1.5rem; border-radius: var(--radius-lg); margin-bottom: 1rem; border-left: 5px solid ${statusColor}; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border-top: 1px solid var(--border-color); border-right: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); ${isSaboy ? 'border: 2px solid var(--primary-color); border-left: 5px solid ' + statusColor + ';' : ''}">
                        <div style="display:flex; justify-content:space-between; margin-bottom: 0.75rem; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
                            <strong style="font-size: 1.3rem; cursor:pointer; text-decoration:underline; ${isSaboy ? 'color: var(--primary-color);' : 'color: var(--text-primary);'}" onclick="viewWaiterReceipt('${o.id}')" title="Chekni ko'rish">${tableDisplay} <i class="fas fa-receipt" style="font-size: 1rem; margin-left: 5px; color: var(--text-secondary);"></i></strong>
                            <div style="display:flex; align-items:center; flex-wrap: wrap; gap: 0.5rem;">
                                <span class="badge" style="background: ${statusColor}; color: white; padding: 0.4rem 0.8rem; font-size: 0.9rem;">${statusText}</span>
                                <span style="color:var(--success-color); font-weight:bold; font-size: 1.3rem;">${o.total.toFixed(2)} so'm</span>
                                <button class="btn warning-btn" style="padding: 0.4rem 0.6rem; font-size: 0.9rem; height: auto; border-radius: var(--radius-md);" onclick="event.stopPropagation(); startEditingOrder('${o.id}')" title="Tahrirlash"><i class="fas fa-edit"></i></button>
                                <button class="btn danger-btn" style="padding: 0.4rem 0.6rem; font-size: 0.9rem; height: auto; border-radius: var(--radius-md);" onclick="event.stopPropagation(); deleteOrderPermanently('${o.id}')" title="Buyurtmani bekor qilish (o'chirish)"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                        ${namesHtml}
                        <p style="font-size:1rem; color:var(--text-secondary); margin-bottom:0.75rem; line-height: 1.5;">${itemsHtml}</p>
                        ${timeDisplay}
                        ${actionButtons}
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <small style="color:var(--text-secondary); font-size:0.85rem;"><i class="fas fa-clock mr-2"></i> ${new Date(o.timestamp).toLocaleString()} ${timeDisplay}</small>
                            <div>
                                <button onclick="viewWaiterReceipt('${o.id}')" style="background: var(--bg-color); border: 1px solid var(--border-color); padding: 0.4rem 0.8rem; border-radius: var(--radius-md); font-size: 0.85rem; cursor: pointer; color: var(--text-color); transition: all 0.2s;"><i class="fas fa-print" style="margin-right:0.3rem;"></i> Chekni ko'rish</button>
                            </div>
                        </div>
                    </div>`;
            });
        }
    }
}

function renderUserStatsOrders() {
    if (!currentUserStatsId) return;
    const user = state.users.find(u => String(u.id) === String(currentUserStatsId));
    if (!user) return;
    
    let allUserOrders = [];
    if (user.role === 'waiter') allUserOrders = state.orders.filter(o => String(o.waiterId) === String(user.login));
    else if (user.role === 'chef') allUserOrders = state.orders.filter(o => String(o.chefId) === String(user.id));
    
    // Apply Date Filter
    let dateFilteredOrders = allUserOrders;
    
    if (currentStatsDateFilterType === 'exact-date' && currentStatsDateFilterValue) {
        dateFilteredOrders = allUserOrders.filter(o => {
            const d = new Date(o.timestamp);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const localDateStr = `${yyyy}-${mm}-${dd}`;
            return localDateStr === currentStatsDateFilterValue;
        });
    } else if (currentStatsDateFilterType === 'exact-month' && currentStatsDateFilterValue) {
        dateFilteredOrders = allUserOrders.filter(o => {
            const d = new Date(o.timestamp);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const localMonthStr = `${yyyy}-${mm}`;
            return localMonthStr === currentStatsDateFilterValue;
        });
    }

    // Total income calculation always includes only ready/completed for real income
    const completedOrders = dateFilteredOrders.filter(o => o.status === 'ready' || o.status === 'completed');
    document.getElementById('stats-total-orders').textContent = dateFilteredOrders.length;
    document.getElementById('stats-total-income').textContent = `${completedOrders.reduce((sum, o) => sum + o.total, 0).toFixed(2)} so'm`;

    let filteredOrders = dateFilteredOrders;
    if (currentStatsFilter !== 'all') {
        filteredOrders = dateFilteredOrders.filter(o => o.status === currentStatsFilter);
    }
    
    const container = document.getElementById('stats-orders-list');
    if(container) {
        container.innerHTML = '';
        if(filteredOrders.length === 0) {
            container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); margin-top: 2rem;">Zakazlar mavjud emas.</p>';
        } else {
            filteredOrders.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
            filteredOrders.forEach(o => {
                let itemsHtml = o.items.map(i => `<b>${i.qty}x</b> ${i.name}`).join(', ');
                let statusColor = 'var(--primary-color)';
                let statusText = 'Yangi';
                if(o.status === 'ready') { statusColor = 'var(--success-color)'; statusText = 'Tayyor'; }
                else if(o.status === 'cancelled') { statusColor = 'var(--danger-color)'; statusText = 'Bekor'; }
                else if(o.status === 'preparing') { statusColor = 'var(--warning-color)'; statusText = 'Jarayonda'; }
                
                container.innerHTML += `
                    <div style="background: white; padding: 1rem; border-radius: var(--radius-md); margin-bottom: 0.75rem; border-left: 4px solid ${statusColor}; box-shadow: 0 2px 5px rgba(0,0,0,0.05); border-top: 1px solid var(--border-color); border-right: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color);">
                        <div style="display:flex; justify-content:space-between; margin-bottom: 0.5rem; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
                            <strong style="font-size: 1.1rem;">Stol ${o.table}</strong>
                            <div style="display:flex; align-items:center; flex-wrap: wrap; gap: 0.5rem;">
                                <span class="badge" style="background: ${statusColor}; color: white; margin-right: 0.5rem;">${statusText}</span>
                                <span style="color:var(--success-color); font-weight:bold; font-size: 1.1rem; margin-right: 0.5rem;">${o.total.toFixed(2)} so'm</span>
                                <button class="btn warning-btn" style="padding: 0.3rem 0.5rem; font-size: 0.8rem; height: auto; border-radius: var(--radius-md);" onclick="event.stopPropagation(); startEditingOrder('${o.id}')" title="Tahrirlash"><i class="fas fa-edit"></i></button>
                                <button class="btn danger-btn" style="padding: 0.3rem 0.5rem; font-size: 0.8rem; height: auto; border-radius: var(--radius-md);" onclick="event.stopPropagation(); deleteOrderPermanently('${o.id}')" title="O'chirish"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                        <p style="font-size:0.9rem; color:var(--text-secondary); margin-bottom:0.5rem; line-height: 1.4;">${itemsHtml}</p>
                        <small style="color:var(--text-secondary); font-size:0.75rem;"><i class="fas fa-clock mr-2"></i> ${new Date(o.timestamp).toLocaleString()}</small>
                    </div>`;
            });
        }
    }
}

// Menu CRUD
document.getElementById('menu-image-upload')?.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(evt) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if(w>h) { if(w>300) { h*=300/w; w=300; } } else { if(h>300) { w*=300/h; h=300; } }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                document.getElementById('menu-icon').value = canvas.toDataURL('image/jpeg', 0.8);
            };
            img.src = evt.target.result;
        };
        reader.readAsDataURL(file);
    }
});

document.getElementById('fish-image-upload')?.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(evt) {
            const img = new Image();
            img.onload = function() {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if(w>h) { if(w>300) { h*=300/w; w=300; } } else { if(h>300) { w*=300/h; h=300; } }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                document.getElementById('fish-add-icon').value = canvas.toDataURL('image/jpeg', 0.8);
            };
            img.src = evt.target.result;
        };
        reader.readAsDataURL(file);
    }
});

let menuIngredients = [];

window.addIngredientRow = function(inventoryId = '', qty = '') {
    const list = document.getElementById('menu-ingredients-list');
    const index = menuIngredients.length;
    menuIngredients.push({ inventory_id: inventoryId, quantity: qty });
    
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '0.5rem';
    row.innerHTML = `
        <select class="form-input" style="flex:2; margin:0;" onchange="menuIngredients[${index}].inventory_id = this.value" required>
            <option value="">Ombordan tanlang...</option>
            ${inventoryItems.map(i => `<option value="${i.id}" ${i.id == inventoryId ? 'selected' : ''}>${i.name} (${i.unit})</option>`).join('')}
        </select>
        <input type="number" class="form-input" style="flex:1; margin:0;" placeholder="Miqdor" step="0.001" value="${qty}" onchange="menuIngredients[${index}].quantity = this.value" required>
        <button type="button" class="btn danger-btn" onclick="this.parentElement.remove(); menuIngredients[${index}].deleted = true;"><i class="fas fa-trash"></i></button>
    `;
    list.appendChild(row);
}

window.openMenuAddModal = function() {
    document.getElementById('menu-form').reset();
    document.getElementById('menu-id').value = '';
    const invQtyInput = document.getElementById('menu-inventory-qty');
    if (invQtyInput) invQtyInput.value = '';
    document.getElementById('menu-ingredients-list').innerHTML = '';
    document.getElementById('btn-delete-menu').style.display = 'none';
    document.getElementById('menu-modal-title').textContent = "Taom Qo'shish";
    menuIngredients = [];
    
    const catSelect = document.getElementById('menu-category');
    if (catSelect) catSelect.innerHTML = '<option value="" disabled selected>Kategoriya tanlang</option>' + state.categories.map(c => `<option value="${c.value}">${c.name}</option>`).join('');
    
    openModal('menu-modal');
}

document.getElementById('menu-form')?.addEventListener('submit', function(e) {
    e.preventDefault();
    const id = document.getElementById('menu-id').value;
    
    const ingredientsToSave = menuIngredients.filter(i => !i.deleted && i.inventory_id && i.quantity).map(i => {
        const invItem = inventoryItems.find(inv => inv.id == i.inventory_id);
        return { inventory_id: i.inventory_id, quantity: i.quantity, unit: invItem ? invItem.unit : 'kg' };
    });
    
    const item = {
        id: id ? parseInt(id) : Date.now(),
        icon: document.getElementById('menu-icon').value,
        name: document.getElementById('menu-name').value,
        category: document.getElementById('menu-category').value,
        price: parseFloat(document.getElementById('menu-price').value),
        unit: 'dona',
        quantity: parseInt(document.getElementById('menu-quantity').value) || 0,
        weight_per_piece: null,
        active: document.getElementById('menu-active').checked ? 1 : 0,
        inventory_quantity: parseFloat(document.getElementById('menu-inventory-qty')?.value || 0),
        ingredients: ingredientsToSave
    };
    
    // Optimistic UI
    const existingIdx = state.menu.findIndex(m => String(m.id) === String(item.id));
    if (existingIdx > -1) state.menu[existingIdx] = item;
    else state.menu.push(item);
    
    closeModal('menu-modal');
    updateDashboards('admin');
    
    fetch(`${API_BASE}/menus`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(item) }).then(res => {
        if(res.ok) showToast(id ? "Maxsulot yangilandi" : "Maxsulot qo'shildi", "success");
    });
});

let selectedFishWeights = new Set();

// Fish Add Form (Admin - baliq qo'shish)
document.getElementById('fish-add-form')?.addEventListener('submit', async function(e) {
    e.preventDefault();
    const nameBase = document.getElementById('fish-add-name').value.trim();
    const pricePerKg = parseFloat(document.getElementById('fish-add-price').value);
    const category = document.getElementById('fish-add-category').value;
    const iconUrl = document.getElementById('fish-add-icon').value.trim() || 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=300&h=300&fit=crop';
    
    if (selectedFishWeights.size === 0) {
        showToast("Kamida bitta vazn tanlang!", "warning");
        return;
    }
    
    let baseId = Date.now();
    let requests = [];
    
    selectedFishWeights.forEach(weight => {
        let price = pricePerKg * weight;
        let menuId = baseId++;
        let item = {
            id: menuId,
            name: `${nameBase} ${weight} kg`,
            price: price,
            category: category,
            icon: iconUrl,
            unit: 'dona',
            quantity: 0,
            weight_per_piece: weight,
            active: 1
        };
        requests.push(fetch(`${API_BASE}/menus`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(item) }));
    });
    
    try {
        await Promise.all(requests);
        showToast("Baliq turlari muvaffaqiyatli qo'shildi!", "success");
        closeModal('fish-add-modal');
        await fetchData(); updateDashboards('admin');
    } catch (err) {
        showToast("Xatolik yuz berdi", "danger");
    }
});

window.deleteFishFromModal = async function() {
    const id = document.getElementById('fish-add-id').value;
    if (!id) return;
    if(!confirm("Haqiqatan ham o'chirasizmi?")) return;
    await fetch(`${API_BASE}/menus/${id}`, { method: 'DELETE' });
    showToast("O'chirildi", "success");
    closeModal('fish-add-modal');
    await fetchData(); updateDashboards('admin');
};

window.editMenu = function(id) {
    const item = state.menu.find(m => String(m.id) === String(id));
    if (!item) return;
    
    const catSelect = document.getElementById('menu-category');
    if (catSelect) catSelect.innerHTML = '<option value="" disabled>Kategoriya tanlang</option>' + state.categories.map(c => `<option value="${c.value}">${c.name}</option>`).join('');
    
    document.getElementById('menu-id').value = item.id;
    document.getElementById('menu-icon').value = item.icon || '';
    document.getElementById('menu-name').value = item.name;
    document.getElementById('menu-category').value = item.category;
    document.getElementById('menu-price').value = item.price;
    document.getElementById('menu-quantity').value = item.quantity || 0;
    const invQtyInput = document.getElementById('menu-inventory-qty');
    if (invQtyInput) invQtyInput.value = ''; // It's only for adding stock, not reading current
    document.getElementById('menu-active').checked = item.active !== 0;
    document.getElementById('menu-modal-title').textContent = "Maxsulotni Tahrirlash";
    document.getElementById('btn-delete-menu').style.display = 'block';
    
    // Ingredientlarni ko'rsatish
    document.getElementById('menu-ingredients-list').innerHTML = '';
    menuIngredients = [];
    
    if (inventoryItems) {
        inventoryItems.forEach(inv => {
            if (inv.linked_menus) {
                const link = inv.linked_menus.find(lm => lm.menu_id == id);
                if (link) {
                    addIngredientRow(inv.id, link.ingredient_qty);
                }
            }
        });
    }
    
    openModal('menu-modal');
};

window.deleteMenuFromModal = function() {
    const id = document.getElementById('menu-id').value;
    if (id) deleteMenu(parseInt(id));
};

window.deleteMenu = function(id) {
    showConfirm("Haqiqatan ham o'chirasizmi?", () => {
        // Optimistic UI
        state.menu = state.menu.filter(m => String(m.id) !== String(id));
        closeModal('menu-modal');
        updateDashboards('admin');
        
        fetch(`${API_BASE}/menus/${id}`, { method: 'DELETE' }).then(() => {
            showToast("O'chirildi", "success");
        });
    });
};

window.toggleMenuActive = async function(id) {
    await fetch(`${API_BASE}/menus/${id}/toggle`, { method: 'PUT' });
    const item = state.menu.find(m => String(m.id) === String(id));
    let newState = item && item.active === 0 ? 'ko\'rsatildi' : 'yashirildi';
    showToast(`Maxsulot ${newState}`, 'success');
    await fetchData(); updateDashboards('admin');
};



// Categories CRUD
document.getElementById('category-form')?.addEventListener('submit', function(e) {
    e.preventDefault();
    const id = document.getElementById('category-id').value;
    const name = document.getElementById('category-name').value;
    let val = document.getElementById('category-value').value;
    if (!val) {
        val = 'cat_' + Date.now();
    }
    const cat = {
        id: id ? id : 'cat_' + Date.now(),
        name: name,
        value: val
    };
    
    // Optimistic UI
    const existingIdx = state.categories.findIndex(c => String(c.id) === String(cat.id));
    if (existingIdx > -1) state.categories[existingIdx] = cat;
    else state.categories.push(cat);
    
    closeModal('category-modal');
    updateDashboards('admin');
    
    fetch(`${API_BASE}/categories`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(cat) }).then(res => {
        if(res.ok) showToast(id ? "Kategoriya yangilandi" : "Kategoriya qo'shildi", "success");
    });
});

window.editCategory = function(id) {
    const cat = state.categories.find(c => c.id === id);
    if (!cat) return;
    document.getElementById('category-id').value = cat.id;
    document.getElementById('category-name').value = cat.name;
    document.getElementById('category-value').value = cat.value;
    document.getElementById('category-modal-title').textContent = "Kategoriyani Tahrirlash";
    document.getElementById('category-modal').classList.add('active');
};

window.saveCategory = async function() {
    const id = document.getElementById('category-id').value;
    const name = document.getElementById('category-name').value;
    const value = document.getElementById('category-value').value;
    if (!name || !value) return;
    const payload = { id: id || Date.now().toString().slice(-6), name, value };
    await fetch(`${API_BASE}/categories`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    showToast("Kategoriya saqlandi", "success");
    closeModal('category-modal');
    await fetchData(); updateDashboards('admin');
};

window.deleteCategory = function(id) {
    showConfirm("Kategoriyani o'chirishga ishonchingiz komilmi? (Bu toifaga tegishli taomlar ham o'chishi yoki muammoga uchrashi mumkin!)", () => {
        // Optimistic UI
        state.categories = state.categories.filter(c => String(c.id) !== String(id));
        closeModal('category-modal');
        updateDashboards('admin');
        
        fetch(`${API_BASE}/categories/${id}`, { method: 'DELETE' }).then(() => {
            showToast("Kategoriya o'chirildi", "success");
        });
    });
};

// Custom Confirm UI Logic
let confirmActionCallback = null;

window.showConfirm = function(msg, callback) {
    const msgEl = document.getElementById('confirm-message');
    const modal = document.getElementById('confirm-modal');
    if(msgEl && modal) {
        msgEl.textContent = msg;
        confirmActionCallback = callback;
        modal.classList.add('active');
    } else {
        if(confirm(msg)) callback();
    }
};

window.closeConfirmModal = function() {
    const modal = document.getElementById('confirm-modal');
    if(modal) modal.classList.remove('active');
    confirmActionCallback = null;
};

window.handleConfirmYes = function() {
    if (confirmActionCallback) {
        confirmActionCallback();
    }
    closeConfirmModal();
};

// --- Chef ---
function renderChefDashboard() {
    const nameEl = document.getElementById('chef-sidebar-name');
    if (nameEl && currentUser) nameEl.textContent = currentUser.name;
    const pendingOrders = state.orders.filter(o => o.status === 'pending' && (!o.chefId || String(o.chefId) === String(currentUser.id)));
    const preparingOrders = state.orders.filter(o => o.status === 'preparing' && o.chefId != null && String(o.chefId) === String(currentUser.id));
    const readyOrders = state.orders.filter(o => o.status === 'ready' && o.chefId != null && String(o.chefId) === String(currentUser.id));
    
    const el1 = document.getElementById('chef-stat-received');
    const el2 = document.getElementById('chef-stat-preparing');
    const el3 = document.getElementById('chef-stat-ready');
    const el4 = document.getElementById('chef-stat-earned');
    
    // Auto accept orders older than 2 minutes (120000ms)
    const now = Date.now();
    pendingOrders.forEach(order => {
        if (order.isAutoAccepting) return;
        const orderTime = new Date(order.timestamp).getTime();
        if ((now - orderTime) >= 120000) {
            order.isAutoAccepting = true;
            try {
                updateOrderStatus(order.id, 'preparing');
            } catch(e) {}
        }
    });
    
    if (el1) el1.textContent = pendingOrders.length;
    if (el2) el2.textContent = preparingOrders.length;
    if (el3) el3.textContent = readyOrders.length;
    if (el4) el4.textContent = `${readyOrders.reduce((s,o)=>s+o.total,0).toFixed(2)} so'm`;

    const container = document.getElementById('chef-orders-container');
    if (!container) return;
    container.innerHTML = '';
    
    let displayOrders = [];
    if (chefOrdersCategory === 'active') {
        displayOrders = [...pendingOrders, ...preparingOrders].filter(o => !o.table.startsWith('Saboy-'));
    } else {
        displayOrders = state.orders.filter(o => o.status === chefOrdersCategory && o.chefId != null && String(o.chefId) === String(currentUser.id) && !o.table.startsWith('Saboy-'));
    }
    
    displayOrders.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    if (displayOrders.length === 0) {
        container.innerHTML = '<p class="text-secondary" style="grid-column: 1/-1; text-align: center;">Zakazlar topilmadi.</p>';
        return;
    }
    
    let htmlAcc = '';
    displayOrders.forEach(order => {
        const waiter = state.users.find(u => u.login === order.waiterId) || {name: 'Noma\'lum'};
        const isPending = order.status === 'pending';
        const isReady = order.status === 'ready';
        const isCancelled = order.status === 'cancelled';
        const isSaboy = order.table.startsWith('Saboy-');
        
        let chefItems = order.items.filter(window.isChefItem);
        let itemsHtml = chefItems.map(i => `<li>${i.qty}x ${i.name}</li>`).join('');
        if (chefItems.length === 0) itemsHtml = `<li style="color:var(--text-secondary);">Faqat ichimlik/qoshimcha (Oshpazga ishi yo'q)</li>`;
        let actionButtons = '';
        if (isPending) actionButtons = `<div style="display:flex; gap:0.5rem; width:100%;"><button class="btn danger-btn" style="flex:1" onclick="updateOrderStatus('${order.id}', 'cancelled')">Bekor</button><button class="btn primary-btn" style="flex:1" onclick="updateOrderStatus('${order.id}', 'preparing')">Qabul</button></div><button class="btn text-primary" style="margin-top:0.5rem; width:100%; border:1px solid var(--primary-color);" onclick="openTransferModal('${order.id}')"><i class="fas fa-exchange-alt"></i> Boshqa oshpazga</button>`;
        else if (order.status === 'preparing') actionButtons = `<button class="btn success-btn" style="width:100%;" onclick="updateOrderStatus('${order.id}', 'ready')"><i class="fas fa-check"></i> Tayyor</button><button class="btn text-primary" style="margin-top:0.5rem; width:100%; border:1px solid var(--primary-color);" onclick="openTransferModal('${order.id}')"><i class="fas fa-exchange-alt"></i> Boshqa oshpazga</button>`;
        else actionButtons = `<span style="color:var(--text-secondary); font-weight:bold;">${isReady ? 'Tugatilgan' : 'Bekor Qilingan'}</span>`;
        
        if (order.status !== 'cancelled') {
            actionButtons += `<button class="btn secondary-btn" style="margin-top:0.5rem; width:100%; background: #e2e8f0; color: #1e293b;" onclick="printChefReceipt('${order.id}')"><i class="fas fa-print"></i> Chek chiqarish</button>`;
            actionButtons += `<button class="btn danger-btn" style="margin-top:0.5rem; width:100%;" onclick="deleteOrderPermanently('${order.id}')"><i class="fas fa-trash"></i> Bekor qilish</button>`;
        }
        actionButtons = `<div style="display:flex; flex-direction:column; width:100%;">${actionButtons}</div>`;
        
        let badgeColor = isPending ? 'var(--warning-color)' : (isReady ? 'var(--success-color)' : (isCancelled ? 'var(--danger-color)' : 'var(--primary-color)'));
        let badgeText = isPending ? 'Yangi' : (isReady ? 'Tayyor' : (isCancelled ? 'Bekor' : 'Tayyorlanmoqda'));
        
        let tableDisplay = isSaboy ? `📦 Saboy (${order.table.split('-')[1]})` : `Stol ${order.table}`;
        let timeDisplay = '';
        if (isReady && order.completedAt) {
            let start = new Date(order.timestamp);
            let end = new Date(order.completedAt);
            let diffMins = Math.round((end - start) / 60000);
            timeDisplay = `<span style="display:block; margin-top:0.5rem; color:var(--text-secondary); font-size:0.8rem;"><i class="fas fa-stopwatch"></i> Tayyorlanish: ${diffMins} daqiqa</span>`;
        }
        
        htmlAcc += `
            <div class="order-card" style="border-left: 4px solid ${badgeColor}; ${isSaboy ? 'border: 2px solid var(--primary-color);' : ''}">
                <div class="order-header"><h3 style="${isSaboy ? 'color: var(--primary-color);' : ''}">${tableDisplay}</h3><span class="badge" style="background: ${badgeColor}">${badgeText}</span></div>
                <div class="order-meta">
                    <span><i class="fas fa-user-tie"></i> ${waiter.name}</span>
                    <span><i class="fas fa-clock"></i> ${new Date(order.timestamp).toLocaleTimeString()}</span>
                </div>
                ${timeDisplay}
                <ul class="order-items-list">${itemsHtml}</ul>
                <div class="order-actions">${actionButtons}</div>
            </div>`;
    });
    container.innerHTML = htmlAcc;
}

function renderChefSaboyOrders() {
    const container = document.getElementById('chef-saboy-container');
    if (!container) return;
    container.innerHTML = '';
    
    let displayOrders = [];
    if (chefSaboyCategory === 'active') {
        displayOrders = state.orders.filter(o => o.table.startsWith('Saboy-') && (o.status === 'pending' || o.status === 'preparing') && (!o.chefId || String(o.chefId) === String(currentUser.id)));
    } else {
        displayOrders = state.orders.filter(o => o.table.startsWith('Saboy-') && o.status === chefSaboyCategory && o.chefId != null && String(o.chefId) === String(currentUser.id));
    }
    
    displayOrders.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    if (displayOrders.length === 0) {
        container.innerHTML = '<p class="text-secondary" style="grid-column: 1/-1; text-align: center;">Saboy zakazlar topilmadi.</p>';
        return;
    }
    
    let htmlAcc = '';
    displayOrders.forEach(order => {
        const waiter = state.users.find(u => u.login === order.waiterId) || {name: 'Noma\'lum'};
        const isPending = order.status === 'pending';
        const isReady = order.status === 'ready';
        const isCancelled = order.status === 'cancelled';
        
        let chefItems = order.items.filter(window.isChefItem);
        let itemsHtml = chefItems.map(i => `<li>${i.qty}x ${i.name}</li>`).join('');
        if (chefItems.length === 0) itemsHtml = `<li style="color:var(--text-secondary);">Faqat ichimlik/qoshimcha (Oshpazga ishi yo'q)</li>`;
        let actionButtons = '';
        if (isPending) actionButtons = `<div style="display:flex; gap:0.5rem; width:100%;"><button class="btn danger-btn" style="flex:1" onclick="updateOrderStatus('${order.id}', 'cancelled')">Bekor</button><button class="btn primary-btn" style="flex:1" onclick="updateOrderStatus('${order.id}', 'preparing')">Qabul</button></div><button class="btn text-primary" style="margin-top:0.5rem; width:100%; border:1px solid var(--primary-color);" onclick="openTransferModal('${order.id}')"><i class="fas fa-exchange-alt"></i> Boshqa oshpazga</button>`;
        else if (order.status === 'preparing') actionButtons = `<button class="btn success-btn" style="width:100%;" onclick="updateOrderStatus('${order.id}', 'ready')"><i class="fas fa-check"></i> Tayyor</button><button class="btn text-primary" style="margin-top:0.5rem; width:100%; border:1px solid var(--primary-color);" onclick="openTransferModal('${order.id}')"><i class="fas fa-exchange-alt"></i> Boshqa oshpazga</button>`;
        else actionButtons = `<span style="color:var(--text-secondary); font-weight:bold;">${isReady ? 'Tugatilgan' : 'Bekor Qilingan'}</span>`;
        
        if (order.status !== 'cancelled') {
            actionButtons += `<button class="btn secondary-btn" style="margin-top:0.5rem; width:100%; background: #e2e8f0; color: #1e293b;" onclick="printChefReceipt('${order.id}')"><i class="fas fa-print"></i> Chek chiqarish</button>`;
            actionButtons += `<button class="btn danger-btn" style="margin-top:0.5rem; width:100%;" onclick="deleteOrderPermanently('${order.id}')"><i class="fas fa-trash"></i> Bekor qilish</button>`;
        }
        actionButtons = `<div style="display:flex; flex-direction:column; width:100%;">${actionButtons}</div>`;
        
        let badgeColor = isPending ? 'var(--warning-color)' : (isReady ? 'var(--success-color)' : (isCancelled ? 'var(--danger-color)' : 'var(--primary-color)'));
        let badgeText = isPending ? 'Yangi' : (isReady ? 'Tayyor' : (isCancelled ? 'Bekor' : 'Tayyorlanmoqda'));
        
        let tableDisplay = `📦 Saboy (${order.table.split('-')[1]})`;
        let timeDisplay = '';
        if (isReady && order.completedAt) {
            let start = new Date(order.timestamp);
            let end = new Date(order.completedAt);
            let diffMins = Math.round((end - start) / 60000);
            timeDisplay = `<span style="display:block; margin-top:0.5rem; color:var(--text-secondary); font-size:0.8rem;"><i class="fas fa-stopwatch"></i> Tayyorlanish: ${diffMins} daqiqa</span>`;
        }
        
        htmlAcc += `
            <div class="order-card" style="border-left: 4px solid ${badgeColor}; border: 2px solid var(--primary-color);">
                <div class="order-header"><h3 style="color: var(--primary-color);">${tableDisplay}</h3><span class="badge" style="background: ${badgeColor}">${badgeText}</span></div>
                <div class="order-meta">
                    <span><i class="fas fa-user-tie"></i> ${waiter.name}</span>
                    <span><i class="fas fa-clock"></i> ${new Date(order.timestamp).toLocaleTimeString()}</span>
                </div>
                ${timeDisplay}
                <ul class="order-items-list">${itemsHtml}</ul>
                <div class="order-actions">${actionButtons}</div>
            </div>`;
    });
    container.innerHTML = htmlAcc;
}

let previousReadyCount = 0;

function checkAudioAlert() {
    if (!currentUser) return;
    if (currentUser.role === 'chef') {
        const pendingCount = state.orders.filter(o => o.status === 'pending').length;
        if (pendingCount > previousPendingCount) {
            alertAudio.play().catch(()=>{});
            showToast("Yangi Zakaz keldi!", "warning");
        }
        previousPendingCount = pendingCount;
    } else if (currentUser.role === 'waiter') {
        const readyCount = state.orders.filter(o => o.waiterId === currentUser.login && o.status === 'ready').length;
        if (readyCount > previousReadyCount) {
            alertAudio.play().catch(()=>{});
            showToast("Buyurtma Tayyor bo'ldi!", "success");
        }
        previousReadyCount = readyCount;
    }
}
window.editingOrderId = null;

window.startEditingOrder = function(orderId) {
    const order = state.orders.find(o => String(o.id) === String(orderId));
    if (!order) return;
    
    window.editingOrderId = orderId;
    currentCart = JSON.parse(JSON.stringify(order.items)); // Deep copy
    
    if (order.table.startsWith('Saboy-')) {
        if(document.getElementById('saboy-room-number')) document.getElementById('saboy-room-number').value = order.table.split('-')[1];
    } else {
        if(document.getElementById('table-number')) document.getElementById('table-number').value = order.table;
    }
    
    if(document.getElementById('customer-name')) document.getElementById('customer-name').value = order.customerName || '';
    
    if(currentUser && currentUser.role === 'admin') {
        const adminMenuBtn = document.querySelector('[data-target="admin-view-menu"] a');
        if(adminMenuBtn) adminMenuBtn.click();
    } else if(currentUser && currentUser.role === 'waiter') {
        const waiterMenuBtn = document.querySelector('[data-target="waiter-view-menu"] a');
        if(waiterMenuBtn) waiterMenuBtn.click();
    }
    
    // Update checkout button text temporarily
    const confirmBtn = document.getElementById('btn-confirm-checkout');
    if (confirmBtn) confirmBtn.innerHTML = '<i class="fas fa-save"></i> O\'zgarishlarni saqlash';
    
    renderCart();
    openCartModal();
    showToast("Buyurtma tahrirlash uchun ochildi!", "info");
};

window.resetEditState = function() {
    if (window.editingOrderId) {
        window.editingOrderId = null;
        currentCart = [];
        renderCart();
        const confirmBtn = document.getElementById('btn-confirm-checkout');
        if (confirmBtn) confirmBtn.innerHTML = '<i class="fas fa-shopping-cart"></i> Sotib olishni tasdiqlash';
    }
};

window.deleteOrderPermanently = function(orderId) {
    showConfirm("Haqiqatan ham bu zakazni butunlay o'chirib tashlamoqchimisiz?", () => {
        // Optimistic UI
        state.orders = state.orders.filter(o => String(o.id) !== String(orderId));
        if(currentUser) updateDashboards(currentUser.role);
        renderUserStatsOrders();
        
        fetch(`${API_BASE}/orders/${orderId}`, { method: 'DELETE' }).then(res => {
            if(res.ok) {
                showToast("Zakaz o'chirildi!", "success");
            } else {
                showToast("Xatolik yuz berdi!", "danger");
            }
        }).catch(err => {
            console.error(err);
            showToast("Tarmoq xatosi", "danger");
        });
    });
};

window.deleteAllOrders = function() {
    showConfirm("Barcha buyurtmalarni butunlay o'chirib tashlamoqchimisiz? Bu amalni ortga qaytarib bo'lmaydi!", () => {
        // Optimistic UI
        state.orders = [];
        if(currentUser) updateDashboards(currentUser.role);
        renderUserStatsOrders();
        
        fetch(`${API_BASE}/orders`, { method: 'DELETE' }).then(res => {
            if(res.ok) {
                showToast("Barcha zakazlar o'chirildi!", "success");
            } else {
                showToast("Xatolik yuz berdi!", "danger");
            }
        }).catch(err => {
            console.error(err);
            showToast("Tarmoq xatosi", "danger");
        });
    });
};

window.changeOrderTable = function(orderId, currentTable) {
    const newTable = prompt("Yangi xona yoki stol raqamini kiriting:", currentTable);
    if (!newTable || newTable === currentTable) return;
    
    fetch(`${API_BASE}/orders/${orderId}/table`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: newTable })
    }).then(res => res.json()).then(res => {
        if (res.success) {
            const order = state.orders.find(o => String(o.id) === String(orderId));
            if (order) order.table = newTable;
            if (currentUser) updateDashboards(currentUser.role);
            showToast("Joy o'zgartirildi!", "success");
        } else {
            showToast("Xatolik yuz berdi", "danger");
        }
    }).catch(err => {
        console.error(err);
        showToast("Tarmoq xatosi", "danger");
    });
};

window.updateOrderStatus = function(orderId, newStatus) {
    const payload = { status: newStatus };
    if (newStatus === 'preparing' || newStatus === 'ready' || newStatus === 'cancelled') payload.chefId = currentUser.id;
    
    const order = state.orders.find(o => o.id === orderId);
    if (order) {
        order.status = newStatus;
        if (payload.chefId) order.chefId = payload.chefId;
        if (newStatus === 'ready') order.completedAt = new Date().toISOString();
        if(currentUser) updateDashboards(currentUser.role);
    }
    
    fetch(`${API_BASE}/orders/${orderId}/status`, { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    .then(async () => {
        if (newStatus === 'ready' && order) {
            const waiters = state.users.filter(u => u.role === 'waiter');
            const notifPromises = waiters.map(w => createNotification(w.login, `Stol ${order.table} buyurtmasi TAYYOR!`, 'success', order.id));
            await Promise.all(notifPromises);
        }
        else if (newStatus === 'cancelled' && order) {
            await createNotification(order.waiterId, `Stol ${order.table} buyurtmasi BEKOR qilindi.`, 'danger', order.id);
        }
    }).catch(console.error);
};

window.isChefItem = function(item) {
    if (!item.category) return true;
    const cat = item.category.toLowerCase();
    const name = (item.name || '').toLowerCase();
    
    // Kategoriyasi ichimlik yoki non bo'lsa
    if (cat.includes('ichimlik') || cat.includes('non') || cat.includes('bar') || cat.includes('drink')) return false;
    
    // Nomi bo'yicha filter
    const excludedKeywords = ['suv', 'choy', 'pepsi', 'fanta', 'cola', 'sprite', 'non', 'lepyoshka', 'sok', 'sharbat', 'dinay', 'kofe'];
    for (let word of excludedKeywords) {
        if (name.includes(word)) return false;
    }
    
    return true;
};

window.printChefReceipt = function(orderId) {
    const order = state.orders.find(o => String(o.id) === String(orderId));
    if (!order) return;
    
    let isSaboy = order.table.startsWith('Saboy-');
    let tableName = isSaboy ? `Saboy (${order.table.split('-')[1]})` : `Stol ${order.table}`;
    const waiter = state.users.find(u => u.login === order.waiterId) || {name: 'Noma\'lum'};
    
    let chefItems = order.items.filter(window.isChefItem);
    
    let shashlikItems = chefItems.filter(i => (i.category || '').toLowerCase().includes('shashlik'));
    let baliqItems = chefItems.filter(i => {
        let cat = (i.category || '').toLowerCase();
        let name = (i.name || '').toLowerCase();
        return cat.includes('baliq') || name.includes('baliq') || i.unit === 'kg';
    });
    let otherChefItems = chefItems.filter(i => {
        let cat = (i.category || '').toLowerCase();
        let name = (i.name || '').toLowerCase();
        let isShashlik = cat.includes('shashlik');
        let isBaliq = cat.includes('baliq') || name.includes('baliq') || i.unit === 'kg';
        return !isShashlik && !isBaliq;
    });
    
    if (shashlikItems.length === 0 && baliqItems.length === 0 && otherChefItems.length === 0) {
        showToast("Oshpaz uchun chek chiqarishga taom topilmadi.", "warning");
        return;
    }

    let htmlContent = '';

    const buildReceiptHTML = (items, title) => {
        let subtotal = items.reduce((sum, i) => sum + (i.price * i.qty), 0);
        let itemsText = items.map(i => {
            if (i.kg && i.basePrice) {
                let totalKg = i.qty * i.kg;
                return `${i.name}\n  ${totalKg} kg x ${i.basePrice.toFixed(0)} = ${(i.price * i.qty).toFixed(0)} so'm`;
            }
            let unitLabel = i.unit === 'kg' ? 'kg' : 'dona';
            return `${i.name}\n  ${i.qty} ${unitLabel} x ${i.price.toFixed(0)} = ${(i.price * i.qty).toFixed(0)} so'm`;
        }).join('\n');

        let text = `================================\n`;
        text += `          GOURMET POS\n`;
        text += `       ${title}\n`;
        text += `================================\n`;
        text += `Sana: ${new Date().toLocaleString()}\n`;
        text += `Stol: ${tableName}\n`;
        text += `Ofitsiant: ${waiter.name}\n`;
        text += `Oshpaz: ${currentUser ? currentUser.name : ''}\n`;
        text += `--------------------------------\n`;
        text += itemsText + `\n`;
        text += `--------------------------------\n`;
        text += `JAMI: ${subtotal.toFixed(0)} so'm\n`;
        text += `================================\n`;
        text += `       Xaridingiz uchun\n`;
        text += `           Rahmat!\n`;
        text += `================================`;
        
        return `
        <div style="width: 300px; padding: 10px; font-family: 'Courier New', Courier, monospace; color: #000; background: #fff; page-break-after: always; margin-bottom: 20px;">
            <div style="text-align: center; margin-bottom: 10px;">
                <img src="chekga.jpg" style="max-width: 100%; height: auto; filter: grayscale(100%);">
            </div>
            <pre style="font-family: inherit; font-size: 17px; font-weight: bold; white-space: pre-wrap; word-wrap: break-word; line-height: 1.3; margin: 0; padding: 0;">${text}</pre>
        </div>`;
    };

    if (baliqItems.length > 0) {
        htmlContent += buildReceiptHTML(baliqItems, "BALIQ CHEKI");
    }

    if (shashlikItems.length > 0) {
        htmlContent += buildReceiptHTML(shashlikItems, "SHASHLIK CHEKI");
    }

    if (otherChefItems.length > 0) {
        htmlContent += buildReceiptHTML(otherChefItems, "BOSHQA TAOMLAR CHEKI");
    }

    const printContainer = document.getElementById('printable-receipt');
    printContainer.innerHTML = htmlContent;
    printContainer.style.display = 'block';
    
    setTimeout(() => {
        window.print();
        setTimeout(() => {
            printContainer.style.display = 'none';
        }, 500);
    }, 100);
};

// --- Waiter ---
window.setWaiterCategory = function(btn, category) {
    if (btn && btn.parentElement) {
        btn.parentElement.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    } else {
        const fc1 = document.getElementById('waiter-menu-filters');
        if (fc1) fc1.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        const fc2 = document.getElementById('admin-menu-filters');
        if (fc2) fc2.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
    }
    currentCategory = category;
    renderWaiterMenu();
};

function renderWaiterDashboard() {
    const waiterNameEl = document.getElementById('waiter-sidebar-name');
    if (waiterNameEl && currentUser) waiterNameEl.textContent = currentUser.name;
    
    // Render dynamic filters
    const filterContainer = document.getElementById('waiter-menu-filters');
    if (filterContainer) {
        let html = `<button class="filter-btn ${currentCategory === 'all' ? 'active' : ''}" onclick="setWaiterCategory(this, 'all')">Hammasi</button>`;
        state.categories.forEach(c => {
            html += `<button class="filter-btn ${currentCategory === c.value ? 'active' : ''}" onclick="setWaiterCategory(this, '${c.value}')">${c.name}</button>`;
        });
        filterContainer.innerHTML = html;
    }

    renderWaiterMenu();
    renderCart();
    checkNotifications();
    renderWaiterOrders();
}

window.acceptOrderForDelivery = async function(id) {
    if(!currentUser) return;
    const order = state.orders.find(o => o.id === id);
    if(order) {
        order.status = 'delivering';
        order.deliveredBy = currentUser.login;
        updateDashboards('waiter');
    }
    fetch(`${API_BASE}/orders/${id}/deliver`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliveredBy: currentUser.login, status: 'delivering' })
    }).then(async (res) => {
        if(res.ok) {
            showToast("Zakazni yetkazish uchun qabul qildingiz", "success");
            await fetchData();
            updateDashboards('waiter');
        }
    }).catch(e => {
        console.error(e);
        showToast("Xatolik yuz berdi", "danger");
    });
};

window.deliverOrderToCustomer = function(id) {
    if(!currentUser) return;
    showConfirm("Mijozga topshirilganini tasdiqlaysizmi?", () => {
        const order = state.orders.find(o => o.id === id);
        if(order) {
            order.status = 'completed';
            order.deliveredBy = currentUser.login;
            updateDashboards('waiter');
        }
        fetch(`${API_BASE}/orders/${id}/deliver`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deliveredBy: currentUser.login, status: 'completed' })
        }).then(res => {
            if(res.ok) {
                showToast("Zakaz yakunlandi (Mijozga berildi)", "success");
            }
        }).catch(e => {
            console.error(e);
            showToast("Xatolik yuz berdi", "danger");
        });
    });
};

function renderWaiterOrders() {
    const container = document.getElementById('waiter-orders-container');
    if (!container) return;
    
    let myOwnOrders = state.orders.filter(o => o.waiterId === currentUser.login);
    let totalIncome = myOwnOrders.reduce((sum, o) => sum + o.total, 0);
    
    // Show: my orders + all ready orders (any waiter can pick up) + orders I'm delivering
    let waiterOrders = state.orders.filter(o => 
        o.waiterId === currentUser.login || 
        (o.status === 'ready' && !String(o.table).startsWith('Saboy-Admin')) ||
        (o.status === 'delivering' && o.deliveredBy === currentUser.login)
    );
    
    // Remove duplicates (if my order is also ready)
    let seen = new Set();
    waiterOrders = waiterOrders.filter(o => {
        if (seen.has(o.id)) return false;
        seen.add(o.id);
        return true;
    });
    
    waiterOrders.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    container.innerHTML = `<div style="grid-column: 1/-1; background: var(--success-color); color: white; padding: 1rem; border-radius: var(--radius-md); text-align: center; margin-bottom: 1rem; box-shadow: 0 4px 6px -1px rgba(16, 185, 129, 0.2);">
        <h3 style="margin: 0; font-size: 1.25rem;">Umumiy Daromadim: ${totalIncome.toFixed(2)} so'm</h3>
        <p style="margin: 0.25rem 0 0 0; opacity: 0.9;">Jami mening buyurtmalarim soni: ${myOwnOrders.length} ta</p>
    </div>`;
    
    if (waiterOrders.length === 0) {
        container.innerHTML += '<p class="text-secondary" style="grid-column: 1/-1; text-align: center;">Sizda hali buyurtmalar yo\'q.</p>';
        return;
    }
    
    let htmlAcc = '';
    waiterOrders.forEach(order => {
        let statusBadge = '';
        if (order.status === 'pending') statusBadge = '<span class="badge" style="background: var(--warning-color)">Yangi</span>';
        else if (order.status === 'preparing') statusBadge = '<span class="badge" style="background: var(--primary-color)">Tayyorlanmoqda</span>';
        else if (order.status === 'ready') statusBadge = '<span class="badge" style="background: var(--success-color)">Tayyor (Oshxonadan oling)</span>';
        else if (order.status === 'delivering') statusBadge = '<span class="badge" style="background: #f59e0b; color: white;">Olib borilmoqda</span>';
        else if (order.status === 'completed') statusBadge = '<span class="badge" style="background: var(--text-secondary)">Yetkazib berildi</span>';
        else if (order.status === 'cancelled') statusBadge = '<span class="badge" style="background: var(--danger-color)">Bekor qilingan</span>';
        let itemsHtml = order.items.map(i => `<li>${i.qty}x ${i.name}</li>`).join('');
        let customerHtml = order.customerName ? `<span style="display:block; margin-top:0.25rem;"><i class="fas fa-user"></i> Mijoz: ${order.customerName}</span>` : '';
        
        // Show original waiter info
        let originalWaiterHtml = '';
        if (order.waiterId !== currentUser.login) {
            let waiterUser = state.users.find(u => u.login === order.waiterId);
            let waiterName = waiterUser ? waiterUser.name : order.waiterId;
            originalWaiterHtml = `<span style="display:block; margin-top:0.25rem; color:var(--primary-color);"><i class="fas fa-user-tag"></i> Zakaz bergan: ${waiterName}</span>`;
        }
        
        // Show who is delivering
        let deliveredByHtml = '';
        if (order.deliveredBy && order.status === 'delivering') {
            let deliverUser = state.users.find(u => u.login === order.deliveredBy);
            let deliverName = deliverUser ? deliverUser.name : order.deliveredBy;
            if (order.deliveredBy === currentUser.login) {
                deliveredByHtml = `<span style="display:block; margin-top:0.25rem; color:#f59e0b; font-weight:600;"><i class="fas fa-running"></i> Siz olib boryapsiz</span>`;
            } else {
                deliveredByHtml = `<span style="display:block; margin-top:0.25rem; color:#f59e0b;"><i class="fas fa-running"></i> Olib boryapti: ${deliverName}</span>`;
            }
        }
        if (order.deliveredBy && order.status === 'completed') {
            let deliverUser = state.users.find(u => u.login === order.deliveredBy);
            let deliverName = deliverUser ? deliverUser.name : order.deliveredBy;
            deliveredByHtml = `<span style="display:block; margin-top:0.25rem; color:var(--text-secondary);"><i class="fas fa-check-circle"></i> Yetkazdi: ${deliverName}</span>`;
        }
        
        // Action buttons based on status
        let actionButtons = `<button class="btn secondary-btn" onclick="viewWaiterReceipt('${order.id}')" style="margin-top:0.5rem; width:100%; border: 1px solid var(--border-color);"><i class="fas fa-receipt"></i> Chekni Ko'rish</button>`;
        actionButtons += `<div style="display:flex; gap:0.5rem; margin-top:0.5rem; flex-wrap: wrap;">
            <button class="btn secondary-btn" style="flex:1; font-size:0.85rem; padding:0.4rem;" onclick="event.stopPropagation(); changeOrderTable('${order.id}', '${order.table}')"><i class="fas fa-exchange-alt"></i> Joyni o'zgartirish</button>
            <button class="btn warning-btn" style="flex:1; font-size:0.85rem; padding:0.4rem;" onclick="event.stopPropagation(); startEditingOrder('${order.id}')"><i class="fas fa-edit"></i> Tahrirlash</button>
            <button class="btn danger-btn" style="flex:1; font-size:0.85rem; padding:0.4rem;" onclick="event.stopPropagation(); deleteOrderPermanently('${order.id}')"><i class="fas fa-trash"></i> Bekor</button>
        </div>`;
        
        if (order.status === 'ready') {
            // Any waiter can pick up - "Oldim" button
            if (!order.deliveredBy || order.deliveredBy === '') {
                actionButtons = `<button class="btn" onclick="pickUpOrder('${order.id}')" style="margin-top:1rem; width:100%; background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; font-weight: 600; font-size: 1rem; padding: 0.75rem;"><i class="fas fa-hand-holding" style="margin-right:0.5rem;"></i> Qabul qildim</button>` + actionButtons;
            }
        } else if (order.status === 'delivering' && order.deliveredBy === currentUser.login) {
            // Only the waiter who picked it up can deliver - "Topshirdim" button
            actionButtons = `<button class="btn" onclick="deliverOrder('${order.id}')" style="margin-top:1rem; width:100%; background: linear-gradient(135deg, #10b981, #059669); color: white; font-weight: 600; font-size: 1rem; padding: 0.75rem;"><i class="fas fa-check-double" style="margin-right:0.5rem;"></i> Topshirdim</button>` + actionButtons;
        }
        
        // Card border style
        let borderStyle = '';
        if (order.status === 'ready') {
            borderStyle = 'border: 2px solid var(--success-color); animation: pulse-border 2s infinite;';
        } else if (order.status === 'delivering' && order.deliveredBy === currentUser.login) {
            borderStyle = 'border: 2px solid #f59e0b;';
        } else if (order.waiterId !== currentUser.login) {
            borderStyle = 'border: 2px dashed var(--primary-color);';
        }
        
        htmlAcc += `
            <div class="order-card" style="${borderStyle}">
                <div class="order-header"><h3>Stol ${order.table}</h3>${statusBadge}</div>
                <div class="order-meta">
                    <span><i class="fas fa-clock"></i> ${new Date(order.timestamp).toLocaleString()}</span>
                    <span><i class="fas fa-dollar-sign"></i> Jami: ${order.total.toFixed(2)} so'm</span>
                    ${customerHtml}
                    ${originalWaiterHtml}
                    ${deliveredByHtml}
                </div>
                <ul class="order-items-list" style="margin-top:0.5rem; max-height:100px; overflow-y:auto;">${itemsHtml}</ul>
                ${actionButtons}
            </div>`;
    });
    container.innerHTML += htmlAcc;
}

// Ofitsiant zakazni oldi — "Oldim" tugmasi
window.pickUpOrder = function(orderId) {
    if(!currentUser) return;
    const order = state.orders.find(o => o.id === orderId);
    if(order) {
        order.status = 'delivering';
        order.deliveredBy = currentUser.login;
        updateDashboards(currentUser.role);
    }
    fetch(`${API_BASE}/orders/${orderId}/deliver`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ deliveredBy: currentUser.login, status: 'delivering' })
    }).then(res => {
        if (res.ok) {
            showToast(`Zakaz olindi! Endi mijozga olib boring.`, 'success');
        } else {
            showToast('Xatolik yuz berdi!', 'danger');
        }
    }).catch(err => {
        console.error(err);
        showToast('Tarmoq xatosi', 'danger');
    });
};

// Ofitsiant zakazni mijozga topshirdi — "Topshirdim" tugmasi
window.deliverOrder = function(orderId) {
    if(!currentUser) return;
    const order = state.orders.find(o => o.id === orderId);
    if(order) {
        order.status = 'completed';
        order.deliveredBy = currentUser.login;
        updateDashboards(currentUser.role);
    }
    fetch(`${API_BASE}/orders/${orderId}/deliver`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ deliveredBy: currentUser.login, status: 'completed' })
    }).then(res => {
        if (res.ok) {
            showToast(`Zakaz mijozga topshirildi!`, 'success');
        } else {
            showToast('Xatolik yuz berdi!', 'danger');
        }
    }).catch(err => {
        console.error(err);
        showToast('Tarmoq xatosi', 'danger');
    });
};

function renderWaiterMenu() {
    renderMenuToGrid('menu-items-container');
    renderMenuToGrid('admin-menu-items-container');
}

function renderMenuToGrid(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    // Filter out inactive items for waiter view
    let activeMenu = state.menu.filter(i => i.active !== 0);
    const filtered = currentCategory === 'all' ? activeMenu : activeMenu.filter(i => i.category === currentCategory);
    
    // Ichimliklarni tartib bo'yicha saralash: Coca-Cola → Pepsi → Fanta → Suv → Energetik → Fusetea
    const drinkBrandOrder2 = {'coca-cola': 1, 'coca cola': 1, 'pepsi': 2, 'fanta': 3, 'oddiy suv': 4, 'suv': 4, 'flesh': 5, 'gorilla': 6, 'adrenaline': 7, 'fusetea': 8};
    filtered.sort((a, b) => {
        if (a.category === 'ichimlik' && b.category === 'ichimlik') {
            let aName = (a.name || '').toLowerCase();
            let bName = (b.name || '').toLowerCase();
            let aBrand = 99, bBrand = 99;
            for (let key in drinkBrandOrder2) {
                if (aName.includes(key)) { aBrand = drinkBrandOrder2[key]; break; }
            }
            for (let key in drinkBrandOrder2) {
                if (bName.includes(key)) { bBrand = drinkBrandOrder2[key]; break; }
            }
            if (aBrand !== bBrand) return aBrand - bBrand;
            let aSize = (aName.match(/(\d+\.?\d*)\s*l/i) || [0, '99'])[1];
            let bSize = (bName.match(/(\d+\.?\d*)\s*l/i) || [0, '99'])[1];
            return parseFloat(aSize) - parseFloat(bSize);
        }
        return (a.id || 0) - (b.id || 0);
    });
    
    let uniqueFiltered = [];
    let seenFish = new Set();
    
    filtered.forEach(item => {
        let catLower = (item.category || '').toLowerCase();
        if (catLower.includes('baliq') || item.unit === 'kg') {
            let baseName = item.name.replace(/[\d\.]+\s*kg$/i, '').trim();
            if (!seenFish.has(baseName)) {
                seenFish.add(baseName);
                let relatedItems = filtered.filter(i => i.name.replace(/[\d\.]+\s*kg$/i, '').trim() === baseName);
                let bestItem = relatedItems.find(i => /1\.0\s*kg$/i.test(i.name) || /1\s*kg$/i.test(i.name));
                if (!bestItem) bestItem = relatedItems.reduce((max, i) => (i.price > max.price ? i : max), relatedItems[0]);
                uniqueFiltered.push({ ...bestItem, displayName: baseName });
            }
        } else {
            uniqueFiltered.push(item);
        }
    });
    
    let htmlContent = '';
    uniqueFiltered.forEach(item => {
        let nameToDisplay = item.displayName || item.name;
        let iconHtml = (item.icon && item.icon.trim() !== '' && item.icon !== 'fa-fish' && item.icon !== 'fa-box') ? `<img src="${item.icon}" onerror="this.outerHTML='<i class=\'fas ${item.unit === 'kg' ? 'fa-fish' : 'fa-box'}\'></i>'">` : `<i class="fas ${item.unit === 'kg' ? 'fa-fish' : 'fa-box'}"></i>`;
        let isOutOfStock = false; // Omborda maxsulot tugamaydigan (cheksiz) qilindi
        let unitLabel = item.unit || 'dona';
        let qtyColor = 'var(--text-secondary)';
        let qtyDisplay = `<div style="font-size:0.85rem; color:${qtyColor}; margin-top:0.3rem;"><i class="fas fa-boxes"></i> Qoldiq: ${(item.quantity || 0).toFixed(1)} ${unitLabel}</div>`;
        
        let onClickAction;
        let catLowerClick = (item.category || '').toLowerCase();
        if (catLowerClick.includes('baliq') || item.unit === 'kg') {
            onClickAction = isOutOfStock ? `showToast('Ushbu maxsulot omborda qolmagan!', 'danger')` : `openFishOrderModal(${item.id})`;
        } else {
            onClickAction = isOutOfStock ? `showToast('Ushbu maxsulot omborda qolmagan!', 'danger')` : `addToCart(${item.id})`;
        }
        
        let typeBadge = item.unit === 'kg'
            ? `<span style="background:#3b82f6; color:white; padding:0.2rem 0.6rem; border-radius:20px; font-size:0.7rem; font-weight:600; display:inline-block; margin-top:0.3rem;"><i class="fas fa-weight-hanging"></i> kg</span>`
            : '';
        let priceLabel = item.unit === 'kg' ? `${item.price.toFixed(0)} so'm/kg` : `${item.price.toFixed(0)} so'm`;
        htmlContent += `
            <div class="menu-item" onclick="${onClickAction}" ${isOutOfStock ? 'style="opacity:0.6; cursor:not-allowed;"' : ''}>
                <div class="menu-item-icon">${iconHtml}</div>
                <h4>${nameToDisplay}</h4><div class="price">${priceLabel}</div>
                ${typeBadge}
                ${qtyDisplay}
            </div>`;
    });
    container.innerHTML = htmlContent;
}

window.addToCart = function(id) {
    const item = state.menu.find(m => m.id === id);
    if (!item) return;
    const existing = currentCart.find(i => i.id === id);
    let requestedQty = existing ? existing.qty + 1 : 1;
    
    // Dona maxsulotlar uchun ombor tekshirish - O'chirildi (Cheksiz)
    /*
    if (item.quantity !== undefined && item.quantity !== null && item.quantity !== '' && requestedQty > Number(item.quantity)) {
        showToast(`Omborda faqat ${Math.floor(item.quantity)} dona qolgan.`, 'warning');
        return;
    }
    */
    
    if (existing) existing.qty++; else currentCart.push({ ...item, qty: 1 });
    renderCart();
};

window.updateCartQty = function(id, delta) {
    if (typeof event !== 'undefined' && event) {
        event.stopPropagation();
        event.preventDefault();
    }
    const item = currentCart.find(i => String(i.id) === String(id));
    if (!item) return;
    
    // Ombor tekshirish - O'chirildi (Cheksiz)
    /*
    if (delta > 0) {
        if (item.unit === 'kg') {
            let menuId = item.menuId || item.id;
            let menuItem = state.menu.find(m => String(m.id) === String(menuId));
            let totalKgInCart = currentCart.filter(c => String(c.menuId || c.id) === String(menuId)).reduce((sum, c) => sum + ((c.kg || 0) * c.qty), 0);
            if (menuItem && menuItem.quantity !== undefined && menuItem.quantity !== null && menuItem.quantity !== '' && (totalKgInCart + (item.kg || 0)) > Number(menuItem.quantity)) {
                showToast(`Omborda yetarli emas (Qoldiq: ${menuItem.quantity} kg)`, 'warning');
                return;
            }
        } else {
            let menuItem = state.menu.find(m => String(m.id) === String(id));
            if (menuItem && menuItem.quantity !== undefined && menuItem.quantity !== null && menuItem.quantity !== '' && (item.qty + 1) > Number(menuItem.quantity)) {
                showToast(`Omborda faqat ${Math.floor(menuItem.quantity)} dona qolgan.`, 'warning');
                return;
            }
        }
    }
    */
    
    item.qty += delta;
    if (item.qty <= 0) currentCart = currentCart.filter(i => String(i.id) !== String(id));
    renderCart();
};

function renderCart() {
    const container = document.getElementById('cart-items-container');
    const totalEl = document.getElementById('cart-total');
    const submitBtn = document.getElementById('btn-submit-order');
    const cartBadge = document.getElementById('cart-badge');
    const adminCartBadge = document.getElementById('admin-cart-badge');
    
    // Update badge
    const totalItems = currentCart.reduce((sum, i) => sum + i.qty, 0);
    if(cartBadge) {
        if(totalItems > 0) {
            cartBadge.textContent = totalItems;
            cartBadge.classList.remove('hidden');
        } else {
            cartBadge.classList.add('hidden');
        }
    }
    if(adminCartBadge) {
        if(totalItems > 0) {
            adminCartBadge.textContent = totalItems;
            adminCartBadge.classList.remove('hidden');
        } else {
            adminCartBadge.classList.add('hidden');
        }
    }
    
    if (!container) return;
    if (currentCart.length === 0) {
        container.innerHTML = '<div class="empty-cart-msg">Savat bo\'sh</div>';
        totalEl.textContent = '$0.00';
        submitBtn.disabled = true;
        return;
    }
    
    let htmlAcc = '';
    let total = 0;
    currentCart.forEach(item => {
        const itemTotal = item.price * item.qty;
        total += itemTotal;
        htmlAcc += `
            <div class="cart-item">
                <div class="cart-item-info">
                    <span class="cart-item-name">${item.name}</span>
                    <span class="cart-item-price">${itemTotal.toFixed(2)} so'm${item.unit === 'kg' ? ' (' + item.kg + ' kg)' : ' (' + item.price.toFixed(0) + ' so\'m/dona)'}</span>
                </div>
                <div class="cart-item-actions">
                    <button class="qty-btn" onclick="updateCartQty('${item.id}', -1)">-</button>
                    <span class="cart-qty">${item.qty}</span>
                    <button class="qty-btn" onclick="updateCartQty('${item.id}', 1)">+</button>
                </div>
            </div>`;
    });
    container.innerHTML = htmlAcc;
    totalEl.textContent = `${total.toFixed(2)} so'm`;
    submitBtn.disabled = false;
}

window.toggleOrderType = function() {
    const isSaboy = document.querySelector('input[name="order-type"]:checked')?.value === 'saboy';
    const tableContainer = document.getElementById('table-number-container');
    const tableInput = document.getElementById('table-number');
    const saboyRoomContainer = document.getElementById('saboy-room-container');
    if (isSaboy) {
        if(tableContainer) tableContainer.style.display = 'none';
        if(tableInput) tableInput.required = false;
        if(saboyRoomContainer) saboyRoomContainer.style.display = 'block';
    } else {
        if(tableContainer) tableContainer.style.display = 'block';
        if(tableInput) tableInput.required = true;
        if(saboyRoomContainer) saboyRoomContainer.style.display = 'none';
    }
};

document.getElementById('btn-submit-order')?.addEventListener('click', () => {
    const orderType = document.querySelector('input[name="order-type"]:checked')?.value || 'dine_in';
    let tableNo = 'Noma\'lum';
    let customerName = document.getElementById('customer-name')?.value.trim() || '';
    
    if (orderType === 'saboy') {
        const lastSaboy = state.orders.filter(o => String(o.table).startsWith('Saboy-')).length;
        const saboyRoom = document.getElementById('saboy-room-number')?.value.trim();
        tableNo = saboyRoom ? `Saboy-${lastSaboy + 1} (Xona: ${saboyRoom})` : `Saboy-${lastSaboy + 1}`;
    } else {
        tableNo = document.getElementById('table-number').value.trim();
        if(!tableNo) return showToast("Stol raqamini kiriting", "warning");
    }
    
    if (currentCart.length === 0) return;
    
    const chefs = state.users.filter(u => u.role === 'chef');
    let assignedChefId = null;
    if (chefs.length > 0) {
        const chefLoads = chefs.map(c => ({ id: c.id, load: state.orders.filter(o => o.chefId != null && String(o.chefId) === String(c.id) && (o.status === 'pending' || o.status === 'preparing')).length }));
        chefLoads.sort((a, b) => a.load - b.load);
        assignedChefId = chefLoads[0].id;
    }
    
    const orderWaiterId = (currentUser && currentUser.role === 'admin') ? 'Admin' : (currentUser ? currentUser.login : 'Noma\'lum');
    
    // If editing an existing order
    if (window.editingOrderId) {
        const editPayload = {
            items: [...currentCart],
            total: currentCart.reduce((sum, i) => sum + (i.price * i.qty), 0)
        };
        const editId = window.editingOrderId;
        
        currentCart = [];
        document.getElementById('table-number').value = '';
        if(document.getElementById('saboy-room-number')) document.getElementById('saboy-room-number').value = '';
        if(document.getElementById('customer-name')) document.getElementById('customer-name').value = '';
        const confirmBtn = document.getElementById('btn-confirm-checkout');
        if (confirmBtn) confirmBtn.innerHTML = 'Sotib Olishni Tasdiqlash';
        
        window.editingOrderId = null;
        renderCart();
        closeModal('cart-modal');
        
        fetch(`${API_BASE}/orders/${editId}/edit`, { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(editPayload) }).then(res => {
            if(res.ok) {
                showToast("Zakaz muvaffaqiyatli tahrirlandi!", "success");
            } else {
                showToast("Xatolik yuz berdi!", "danger");
            }
        });
        
    } else {
        const order = {
            id: Date.now().toString().slice(-6), table: tableNo, peopleCount: 1, customerName: customerName,
            items: [...currentCart], total: currentCart.reduce((sum, i) => sum + (i.price * i.qty), 0),
            status: 'pending', waiterId: orderWaiterId, chefId: assignedChefId, timestamp: new Date().toISOString()
        };
        
        // Optimistic UI updates
        currentCart = [];
        document.getElementById('table-number').value = '';
        if(document.getElementById('saboy-room-number')) document.getElementById('saboy-room-number').value = '';
        if(document.getElementById('customer-name')) document.getElementById('customer-name').value = '';
        renderCart();
        closeModal('cart-modal');
        
        fetch(`${API_BASE}/orders`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(order) }).then(res => {
            if(res.ok) {
                showToast("Zakaz yuborildi!", "success");
            
            // Auto-print receipt for admin orders (Saboy & Table)
            if (currentUser && currentUser.role === 'admin') {
                state.orders.push(order);
                const hasServiceCharge = state.settings.service_charge > 0;
                
                setTimeout(() => {
                    // 1. Oshpaz uchun chek (faqat taomlar bilan)
                    window.printChefReceipt(order.id);
                    
                    // 2. Mijoz uchun to'liq chek (1.5 soniyadan keyin chiqadi va arxivlaydi)
                    setTimeout(() => {
                        generateReceiptText(order.table, hasServiceCharge);
                        window.printReceipt();
                    }, 1500);
                }, 500);
            }
        }
        else showToast("Xatolik yuz berdi!", "danger");
    });
    } // Close else block
    
    // Redirect
    if (window.currentSaboyContext === 'admin') {
        const adminSaboyBtn = document.querySelector('[data-target=\'admin-view-saboy\'] a');
        if (adminSaboyBtn) adminSaboyBtn.click();
    } else if (window.currentSaboyContext === 'admin-table') {
        const adminMapBtn = document.querySelector('[data-target=\'admin-view-map\'] a');
        if (adminMapBtn) adminMapBtn.click();
    } else if (window.currentSaboyContext === 'chef') {
        const chefSaboyBtn = document.querySelector('[data-target=\'chef-view-saboy\'] a');
        if (chefSaboyBtn) chefSaboyBtn.click();
    } else {
        if(currentUser && currentUser.role === 'admin') {
            const adminDashBtn = document.querySelector('[data-target=\'admin-view-dashboard\'] a');
            if(adminDashBtn) adminDashBtn.click();
        } else if(currentUser && currentUser.role === 'waiter') {
            const waiterOrdersBtn = document.querySelector('[data-target=\'waiter-view-orders\'] a');
            if(waiterOrdersBtn) waiterOrdersBtn.click();
        }
    }
});

// Receipt Generation
function renderReceiptTables() {
    const container = document.getElementById('receipt-tables-grid');
    if (!container) return;
    
    const activeOrders = state.orders.filter(o => o.status !== 'cancelled' && o.status !== 'archived');
    const activeTables = [...new Set(activeOrders.map(o => o.table))].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}));
    
    let htmlAcc = '';
    activeTables.forEach(table => {
        htmlAcc += `
            <div class="order-card" style="cursor:pointer; text-align:center; padding:1rem;" onclick="renderReceiptPreview('${table}')">
                <i class="fas fa-chair" style="font-size:2rem; color:var(--primary-color); margin-bottom:0.5rem;"></i>
                <h3 style="margin:0;">Stol ${table}</h3>
            </div>
        `;
    });
    container.innerHTML = htmlAcc;
    
    document.getElementById('receipt-preview-container').style.display = 'none';
}

let currentReceiptTable = null;
let currentReceiptTotal = 0;
let currentReceiptItems = [];
let currentReceiptServiceCharge = 0;

window.renderReceiptPreview = function(table) {
    if (!table) return;
    currentReceiptTable = table;
    
    const tableOrders = state.orders.filter(o => o.table === currentReceiptTable && o.status !== 'cancelled' && o.status !== 'archived');
    if (tableOrders.length === 0) return;
    
    // Show payment section
    document.getElementById('receipt-payment-section').style.display = 'block';
    document.getElementById('receipt-cash-given').value = '';
    document.getElementById('receipt-change-display').textContent = '0 so\'m';
    document.getElementById('receipt-service-charge').checked = false;
    
    generateReceiptText(table, false);
};

function generateReceiptText(table, withServiceCharge) {
    currentReceiptTable = table;
    const tableOrders = state.orders.filter(o => o.table === table && o.status !== 'cancelled' && o.status !== 'archived');
    if (tableOrders.length === 0) return;
    
    let aggregatedItems = {};
    tableOrders.forEach(order => {
        order.items.forEach(item => {
            if (aggregatedItems[item.id]) {
                aggregatedItems[item.id].qty += item.qty;
            } else {
                aggregatedItems[item.id] = { ...item };
            }
        });
    });
    
    const items = Object.values(aggregatedItems);
    let subtotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    let serviceAmount = withServiceCharge ? Math.round(subtotal * 0.08) : 0;
    let total = subtotal + serviceAmount;
    currentReceiptTotal = total;
    currentReceiptItems = items;
    currentReceiptServiceCharge = serviceAmount;
    
    const waiterId = tableOrders[0].waiterId;
    const waiter = state.users.find(u => u.login === waiterId);
    
    let receiptHTML = `
    <div style="font-family: 'Courier New', Courier, monospace; font-size: 13px; font-weight: bold; color: black; width: 100%; padding: 0;">
        <div style="text-align: center; margin-bottom: 5px;">
            <img src="chekga.jpg" style="width: 100%; height: auto;" alt="Logo" />
        </div>
        <div style="text-align: center; margin-bottom: 5px;">RESTORAN CHEKI</div>
        <div style="border-bottom: 1px dashed black; margin-bottom: 5px;"></div>
        <div>Stol: ${table}</div>
        <div>Sana: ${new Date().toLocaleString()}</div>
        <div>Ofitsiant: ${waiter ? waiter.name : waiterId}</div>
        <div style="border-bottom: 1px dashed black; margin-top: 5px; margin-bottom: 5px;"></div>
        
        <table style="width: 100%; font-size: 16px; font-weight: bold; border-collapse: collapse;">
            <tr>
                <th style="text-align: left; padding-bottom: 4px;">Nomi</th>
                <th style="text-align: center; padding-bottom: 4px;">Soni</th>
                <th style="text-align: right; padding-bottom: 4px;">Narx</th>
            </tr>
    `;
    
    items.forEach(item => {
        let price = (item.price * item.qty).toLocaleString();
        let qtyDisplay = item.qty + 'x';
        if (item.kg && item.basePrice) {
            qtyDisplay = (item.qty * item.kg) + 'kg';
        }
        receiptHTML += `
            <tr>
                <td style="padding-bottom: 4px; padding-right: 5px;">${item.name}</td>
                <td style="text-align: center; padding-bottom: 4px; white-space: nowrap;">${qtyDisplay}</td>
                <td style="text-align: right; padding-bottom: 4px; white-space: nowrap;">${price}</td>
            </tr>
        `;
    });
    
    receiptHTML += `
        </table>
        <div style="border-bottom: 1px dashed black; margin-top: 5px; margin-bottom: 5px;"></div>
    `;
    
    if (withServiceCharge) {
        receiptHTML += `
            <div style="display: flex; justify-content: space-between;"><span>ORALIQ JAMI:</span> <span>${subtotal.toLocaleString()}</span></div>
            <div style="display: flex; justify-content: space-between;"><span>XIZMAT HAQI:</span> <span>${serviceAmount.toLocaleString()}</span></div>
            <div style="border-bottom: 1px dashed black; margin-top: 5px; margin-bottom: 5px;"></div>
        `;
    }
    
    receiptHTML += `
        <div style="display: flex; justify-content: space-between; font-size: 17px; font-weight: bold;"><span>JAMI:</span> <span>${total.toLocaleString()}</span></div>
    `;
    
    // Add payment info if cash given
    const cashGiven = parseFloat(document.getElementById('receipt-cash-given').value) || 0;
    if (cashGiven > 0) {
        let change = cashGiven - total;
        receiptHTML += `
            <div style="display: flex; justify-content: space-between; margin-top: 5px;"><span>BERILGAN:</span> <span>${cashGiven.toLocaleString()}</span></div>
            <div style="display: flex; justify-content: space-between;"><span>QAYTIM:</span> <span>${change.toLocaleString()}</span></div>
        `;
    }
    
    receiptHTML += `
        <div style="border-bottom: 1px dashed black; margin-top: 5px; margin-bottom: 10px;"></div>
        <div style="text-align: center;">
            Xaridingiz uchun rahmat!<br>
            Tel: +998 95 018 19 00
        </div>
    </div>
    `;
    
    document.getElementById('receipt-preview-content').innerHTML = receiptHTML;
    document.getElementById('receipt-preview-container').style.display = 'block';
    
    // Update change display
    const changeDisplay = document.getElementById('receipt-change-display');
    const cashGivenVal = parseFloat(document.getElementById('receipt-cash-given').value) || 0;
    if (cashGivenVal > 0) {
        const changeVal = cashGivenVal - currentReceiptTotal;
        changeDisplay.textContent = `${changeVal.toFixed(0)} so'm`;
        changeDisplay.style.color = changeVal >= 0 ? 'var(--success-color)' : 'var(--danger-color)';
    } else {
        changeDisplay.textContent = "0 so'm";
        changeDisplay.style.color = 'var(--success-color)';
    }
}

window.updateReceiptChange = function() {
    if (currentReceiptTable) {
        const withService = document.getElementById('receipt-service-charge').checked;
        generateReceiptText(currentReceiptTable, withService);
    }
};

window.updateReceiptWithService = function() {
    if (currentReceiptTable) {
        const withService = document.getElementById('receipt-service-charge').checked;
        generateReceiptText(currentReceiptTable, withService);
    }
};

window.printReceipt = async function() {
    const htmlContent = document.getElementById('receipt-preview-content').innerHTML;
    if (!htmlContent) { showToast('Chek topilmadi', 'danger'); return; }
    
    // Chek matnini printerga tayyorlash
    const printContainer = document.getElementById('printable-receipt');
    printContainer.innerHTML = htmlContent;
    printContainer.style.display = 'block';
    
    window.print();
    
    setTimeout(() => {
        printContainer.style.display = 'none';
    }, 500);
    
    setTimeout(async () => {
        
        if (currentReceiptTable) {
            const cashGiven = parseFloat(document.getElementById('receipt-cash-given').value) || 0;
            const data = {
                table: currentReceiptTable,
                items: currentReceiptItems,
                total: currentReceiptTotal,
                service_charge: currentReceiptServiceCharge,
                cash_given: cashGiven
            };
            try {
                await fetch(`${API_BASE}/receipts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                showToast("Chek printerga yuborildi va stol bo'shatildi", "success");
                await fetchData();
                updateDashboards('admin');
                
                document.getElementById('receipt-preview-container').style.display = 'none';
                document.getElementById('receipt-payment-section').style.display = 'none';
            } catch(e) {
                console.error(e);
                showToast("Chekni arxivlashda xatolik yuz berdi", "danger");
            }
        }
    }, 1000);
};

window.fetchAndRenderArchivedReceipts = async function() {
    try {
        const response = await fetch(`${API_BASE}/receipts`);
        const receipts = await response.json();
        const container = document.getElementById('archived-receipts-container');
        if (!container) return;
        container.innerHTML = '';
        
        if (receipts.length === 0) {
            container.innerHTML = '<p class="text-secondary" style="grid-column: 1/-1; text-align: center;">Arxiv cheklar topilmadi.</p>';
            return;
        }
        
        receipts.forEach(r => {
            let items = [];
            try { items = JSON.parse(r.items); } catch(e) {}
            let itemsHtml = items.map(i => `<li>${i.name} x${i.qty}</li>`).join('');
            
            container.innerHTML += `
                <div class="order-card" style="border-left: 4px solid var(--text-secondary); position: relative;">
                    <button class="btn danger-btn" style="position: absolute; top: 10px; right: 10px; padding: 0.3rem 0.6rem; font-size: 0.8rem;" onclick="deleteArchivedReceipt(${r.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                    <div class="order-header" style="padding-right: 40px;">
                        <h3>Stol ${r.table}</h3>
                        <span class="badge" style="background: var(--text-secondary)">Arxiv</span>
                    </div>
                    <div class="order-meta" style="flex-direction: column; gap: 0.25rem;">
                        <span><i class="fas fa-clock"></i> ${new Date(r.timestamp).toLocaleString()}</span>
                        <span><i class="fas fa-money-bill"></i> Jami: ${r.total} so'm</span>
                    </div>
                    <ul class="order-items-list">${itemsHtml}</ul>
                </div>
            `;
        });
    } catch (error) {
        console.error(error);
        showToast("Arxiv cheklarni yuklashda xatolik", "danger");
    }
};

window.deleteArchivedReceipt = async function(id) {
    if (!confirm("Haqiqatan ham bu arxiv chekni o'chirmoqchimisiz?")) return;
    try {
        const response = await fetch(`${API_BASE}/receipts/${id}`, { method: 'DELETE' });
        const res = await response.json();
        if (res.success) {
            showToast("Chek o'chirildi", "success");
            fetchAndRenderArchivedReceipts();
        } else {
            showToast(res.error || "Xatolik yuz berdi", "danger");
        }
    } catch (e) {
        console.error(e);
        showToast("Xatolik yuz berdi", "danger");
    }
};

window.deleteAllArchivedReceipts = async function() {
    if (!confirm("Barcha arxiv cheklarni o'chirmoqchimisiz? Bu amalni ortga qaytarib bo'lmaydi!")) return;
    try {
        const response = await fetch(`${API_BASE}/receipts`, { method: 'DELETE' });
        const res = await response.json();
        if (res.success) {
            showToast("Barcha arxiv cheklar o'chirildi", "success");
            fetchAndRenderArchivedReceipts();
        } else {
            showToast(res.error || "Xatolik yuz berdi", "danger");
        }
    } catch (e) {
        console.error(e);
        showToast("Xatolik yuz berdi", "danger");
    }
};

window.renderUserProfile = function(role) {
    if (!currentUser) return;
    
    document.getElementById(`${role}-profile-name`).textContent = currentUser.name;
    
    let userOrders = [];
    if (role === 'waiter') userOrders = state.orders.filter(o => String(o.waiterId) === String(currentUser.login));
    else if (role === 'chef') userOrders = state.orders.filter(o => String(o.chefId) === String(currentUser.id));
    
    const completedOrders = userOrders.filter(o => o.status === 'ready' || o.status === 'completed' || o.status === 'archived');
    
    let userSalaries = state.salaries.filter(s => String(s.userId) === String(currentUser.id));
    userSalaries.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    let lastSalaryTimestamp = userSalaries.length > 0 ? new Date(userSalaries[0].timestamp).getTime() : 0;
    let lastPercentage = userSalaries.length > 0 ? userSalaries[0].percentage : 0;
    
    const unpaidOrders = completedOrders.filter(o => {
        return new Date(o.timestamp).getTime() > lastSalaryTimestamp;
    });
    
    const totalEarnings = unpaidOrders.reduce((sum, o) => sum + o.total, 0);
    
    document.getElementById(`${role}-profile-percentage`).textContent = lastPercentage + '%';
    const salesEl = document.getElementById(`${role}-profile-sales`);
    if(salesEl) salesEl.textContent = totalEarnings.toFixed(2) + " so'm";
    
    // Render History
    const historyContainer = document.getElementById(`${role}-profile-history`);
    if(historyContainer) {
        if(userSalaries.length === 0) {
            historyContainer.innerHTML = '<p class="text-secondary">Hali oylik olinmagan.</p>';
        } else {
            let html = '<table class="styled-table" style="width:100%;"><thead><tr><th>Sana</th><th>Oylik Summasi</th><th>Foiz</th></tr></thead><tbody>';
            userSalaries.forEach(s => {
                const sDate = new Date(s.timestamp).toLocaleString();
                html += `<tr>
                    <td>${sDate}</td>
                    <td style="color:var(--success-color); font-weight:bold;">${s.amount.toFixed(2)} so'm</td>
                    <td>${s.percentage}%</td>
                </tr>`;
            });
            html += '</tbody></table>';
            historyContainer.innerHTML = html;
        }
    }
};

// Notifications
async function createNotification(userId, message, type, orderId = null) {
    const notif = { id: Date.now(), userId, message, type, read: false, timestamp: new Date().toISOString(), orderId };
    await fetch(`${API_BASE}/notifications`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(notif) });
}

function checkNotifications() {
    if (!currentUser) return;
    const userNotifs = state.notifications.filter(n => n.userId === currentUser.login);
    const unread = userNotifs.filter(n => !n.read);
    const badge = document.getElementById('notification-badge');
    if (badge) {
        if (unread.length > 0) {
            badge.textContent = unread.length;
            badge.classList.remove('hidden');
            const latest = unread[unread.length - 1];
            const age = Date.now() - new Date(latest.timestamp).getTime();
            if (age < 5000 && !latest.toastShown) {
                showToast(latest.message, latest.type);
                if (latest.type === 'saboy_ready') {
                    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
                    const utterance = new SpeechSynthesisUtterance(latest.message);
                    utterance.lang = 'uz-UZ';
                    window.speechSynthesis.speak(utterance);
                }
                latest.toastShown = true; // Prevents re-toasting locally
            }
        } else {
            badge.classList.add('hidden');
        }
    }
}

window.openNotificationsModal = async function() {
    const modal = document.getElementById('notification-modal');
    const list = document.getElementById('modal-notifications-list');
    modal.classList.add('active');
    
    const userNotifs = state.notifications.filter(n => n.userId === currentUser.login).reverse();
    list.innerHTML = '';
    if (userNotifs.length === 0) list.innerHTML = '<p class="text-secondary" style="text-align:center;">Xabarlar yo\'q</p>';
    else {
        userNotifs.forEach(n => {
            let actionHtml = '';
            
            // Xabarga biriktirilgan zakaz bo'lsa va u ofitsiant uchun dolzarb bo'lsa, tugmalarni ko'rsatamiz
            if (n.orderId) {
                const order = state.orders.find(o => o.id === n.orderId);
                if (order && order.status === 'ready') {
                    actionHtml = `<button class="btn success-btn" style="width:100%; margin-top:0.5rem; padding:0.4rem; font-size:0.9rem;" onclick="acceptOrderForDelivery('${order.id}'); dismissNotification('${n.id}')"><i class="fas fa-hand-holding"></i> Qabul qildim</button>`;
                } else if (order && order.status === 'delivering' && order.deliveredBy === currentUser.login) {
                    actionHtml = `<button class="btn" style="width:100%; margin-top:0.5rem; padding:0.4rem; font-size:0.9rem; background:#8b5cf6; color:white;" onclick="deliverOrderToCustomer('${order.id}'); dismissNotification('${n.id}')"><i class="fas fa-check-circle"></i> Mijozga topshirdim</button>`;
                } else if (order && (order.status === 'completed' || (order.status === 'delivering' && order.deliveredBy !== currentUser.login))) {
                    // Agar boshqa ofitsiant qabul qilgan bo'lsa yoki tugagan bo'lsa, xabarni xiralashtiramiz
                    actionHtml = `<div style="margin-top:0.5rem; font-size:0.85rem; color:var(--text-secondary);"><i class="fas fa-info-circle"></i> Boshqa ofitsiant oldi yoki yakunlandi</div>`;
                }
            }

            list.innerHTML += `
                <div class="notification-item ${!n.read ? 'unread' : ''}" style="position: relative;">
                    <button onclick="dismissNotification('${n.id}')" style="position: absolute; right: 10px; top: 10px; background: none; border: none; color: var(--text-secondary); cursor: pointer;"><i class="fas fa-times"></i></button>
                    <h4>System</h4><p>${n.message}</p>
                    <small class="text-secondary">${new Date(n.timestamp).toLocaleTimeString()}</small>
                    ${actionHtml}
                </div>`;
        });
    }
    
    await fetch(`${API_BASE}/notifications/read`, { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({userId: currentUser.login}) });
    await fetchData();
    checkNotifications();
};

window.dismissNotification = async function(id) {
    try {
        await fetch(`${API_BASE}/notifications/${id}`, { method: 'DELETE' });
        await fetchData();
        openNotificationsModal(); // refresh list
    } catch (e) {
        console.error("Xabarni o'chirishda xatolik:", e);
    }
};

// Ofitsiant - Baliq buyurtma modali
window.openFishOrderModal = function(itemId) {
    const item = state.menu.find(m => m.id === itemId);
    if (!item) return;
    document.getElementById('fish-order-item-id').value = item.id;
    document.getElementById('fish-order-selected-kg').value = '';
    let displayName = item.name.replace(/[\d\.]+\s*kg$/i, '').trim();
    document.getElementById('fish-order-name').textContent = displayName;
    document.getElementById('fish-order-price-per-kg').textContent = `${item.price.toFixed(0)} so'm / 1 kg`;
    document.getElementById('fish-order-stock').textContent = `Omborda: ${(item.quantity || 0).toFixed(1)} kg`;
    document.getElementById('fish-order-total').textContent = "0 so'm";
    document.getElementById('fish-order-selected-label').textContent = '—';
    
    // Vazn tugmalarni yaratish
    const container = document.getElementById('fish-order-weights');
    container.innerHTML = '';
    
    // Barcha o'xshash baliqlarni (yashiringan va yashirinmagan) topish
    let allRelatedItems = state.menu.filter(m => m.name.replace(/[\d\.]+\s*kg$/i, '').trim() === displayName);
    
    // 0.5 dan 3.0 gacha doim aylanadi
    for (let w = 0.5; w <= 3.0; w += 0.1) {
        let weight = parseFloat(w.toFixed(1));
        
        // Shu vazn uchun maxsus menyu borligini tekshiramiz (masalan, "Amur baliq 0.7 kg")
        let explicitItem = allRelatedItems.find(i => {
            let match = i.name.match(/([\d\.]+)\s*kg$/i);
            return match && parseFloat(match[1]) === weight;
        });

        // Agar maxsus menyu bor bo'lsa va u YASHIRILGAN (active === 0) bo'lsa, bu vaznni chiqarmaymiz!
        if (explicitItem && explicitItem.active === 0) {
            continue; // Skip this weight
        }

        let isDisabled = weight > (item.quantity || 0);
        let btn = document.createElement('button');
        btn.type = 'button';
        btn.className = isDisabled ? 'btn secondary-btn' : 'btn primary-btn';
        btn.style.cssText = 'padding:0.4rem 0.7rem; font-size:0.9rem; min-width:65px;';
        btn.textContent = `${weight} kg`;
        btn.disabled = isDisabled;
        if (isDisabled) btn.style.opacity = '0.4';
        
        btn.onclick = function() {
            container.querySelectorAll('button').forEach(b => { b.style.outline = 'none'; b.style.boxShadow = ''; });
            btn.style.outline = '3px solid var(--success-color)';
            btn.style.boxShadow = '0 0 10px rgba(16,185,129,0.5)';
            document.getElementById('fish-order-selected-kg').value = weight;
            document.getElementById('fish-order-selected-label').textContent = weight + ' kg';
            
            // Agar maxsus menyu bo'lsa, uning narxini ishlatamiz, yo'qsa hisoblaymiz
            let total = explicitItem ? explicitItem.price : (item.price * weight);
            document.getElementById('fish-order-total').textContent = total.toFixed(0) + " so'm";
        };
        container.appendChild(btn);
    }
    
    document.getElementById('fish-order-modal').classList.add('active');
};

window.addFishOrderToCart = function() {
    const itemId = parseInt(document.getElementById('fish-order-item-id').value);
    const item = state.menu.find(m => m.id === itemId);
    if (!item) return;
    
    const kg = parseFloat(document.getElementById('fish-order-selected-kg').value);
    if (!kg || kg <= 0) {
        showToast('Vaznni tanlang!', 'warning');
        return;
    }

    const variantInput = document.querySelector('input[name="fish-variant"]:checked');
    const variant = variantInput ? variantInput.value : "Sousli";
    
    // Ombor tekshirish - O'chirildi (Cheksiz)
    /*
    let totalKgInCart = currentCart.filter(c => (c.menuId || c.id) === itemId).reduce((sum, c) => sum + ((c.kg || 0) * c.qty), 0);
    if ((totalKgInCart + kg) > (item.quantity || 0)) {
        showToast(`Omborda yetarli emas (Qoldiq: ${(item.quantity || 0).toFixed(1)} kg)`, 'warning');
        return;
    }
    */
    
    const cartId = `fish_${itemId}_${kg}_${variant}`;
    const existing = currentCart.find(c => c.id === cartId);
    
    if (existing) {
        existing.qty++;
    } else {
        let baseName = item.name.replace(/[\d\.]+\s*kg$/i, '').trim();
        currentCart.push({ 
            id: cartId, 
            menuId: itemId, 
            name: `${baseName} (${kg} kg) - ${variant}`, 
            price: item.price * kg,
            category: item.category,
            kg: kg,
            qty: 1,
            unit: 'dona'
        });
    }
    
    closeModal('fish-order-modal');
    renderCart();
};

window.openCartModal = function() {
    document.getElementById('cart-modal').classList.add('active');
};

// Modals
window.openModal = function(id, role = null) {
    if (id === 'staff-modal') {
        document.getElementById('staff-form').reset();
        document.getElementById('staff-id').value = '';
        document.getElementById('staff-role').value = role;
        document.getElementById('staff-modal-title').textContent = role === 'chef' ? "Oshpaz Qo'shish" : "Ofitsiant Qo'shish";
        generateCredentials();
    } else if (id === 'fish-add-modal') {
        document.getElementById('fish-add-form').reset();
        document.getElementById('fish-add-id').value = '';
        document.getElementById('fish-add-modal-title').textContent = "Yangi Baliq Qo'shish";
        document.getElementById('btn-delete-fish').style.display = 'none';
        
        const catSelect = document.getElementById('fish-add-category');
        if (catSelect) {
            catSelect.innerHTML = '<option value="" disabled selected>Kategoriya tanlang</option>' + state.categories.map(c => `<option value="${c.value}">${c.name}</option>`).join('');
            let baliqCat = state.categories.find(c => c.value.toLowerCase().includes('baliq') || c.name.toLowerCase().includes('baliq'));
            if (baliqCat) catSelect.value = baliqCat.value;
        }
        
        selectedFishWeights.clear();
        const container = document.getElementById('fish-add-weights');
        if (container) {
            container.innerHTML = '';
            for (let w = 0.5; w <= 3.0; w += 0.1) {
                let weight = parseFloat(w.toFixed(1));
                let btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn secondary-btn';
                btn.style.cssText = 'padding:0.4rem 0.7rem; font-size:0.9rem; min-width:65px; border-radius:8px; margin-bottom:4px;';
                btn.textContent = `${weight} kg`;
                btn.onclick = function() {
                    if (selectedFishWeights.has(weight)) {
                        selectedFishWeights.delete(weight);
                        btn.classList.remove('primary-btn');
                        btn.classList.add('secondary-btn');
                    } else {
                        selectedFishWeights.add(weight);
                        btn.classList.remove('secondary-btn');
                        btn.classList.add('primary-btn');
                    }
                };
                container.appendChild(btn);
            }
        }
    } else if (id === 'category-modal') {
        document.getElementById('category-form').reset();
        document.getElementById('category-id').value = '';
        document.getElementById('category-modal-title').textContent = "Yangi Kategoriya Qo'shish";
    }
    document.getElementById(id).classList.add('active');
};
window.closeModal = function(id) { document.getElementById(id).classList.remove('active'); };

window.addCustomFishWeight = function() {
    const input = document.getElementById('fish-custom-weight');
    if (!input || !input.value) return;
    let weight = parseFloat(input.value);
    if (isNaN(weight) || weight <= 0) return;
    weight = parseFloat(weight.toFixed(2));
    
    if (selectedFishWeights.has(weight)) {
        input.value = '';
        return;
    }
    
    const container = document.getElementById('fish-add-weights');
    if (!container) return;
    
    let btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary-btn';
    btn.style.cssText = 'padding:0.4rem 0.7rem; font-size:0.9rem; min-width:65px; border-radius:8px; margin-bottom:4px;';
    btn.textContent = `${weight} kg`;
    
    selectedFishWeights.add(weight);
    
    btn.onclick = function() {
        if (selectedFishWeights.has(weight)) {
            selectedFishWeights.delete(weight);
            btn.classList.remove('primary-btn');
            btn.classList.add('secondary-btn');
        } else {
            selectedFishWeights.add(weight);
            btn.classList.remove('secondary-btn');
            btn.classList.add('primary-btn');
        }
    };
    
    container.appendChild(btn);
    input.value = '';
};

function setupEventListeners() {
    document.getElementById('login-form').addEventListener('submit', (e) => {
        e.preventDefault();
        login(document.getElementById('username').value, document.getElementById('password').value);
    });

    document.querySelectorAll('.nav-links a').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const a = e.target.closest('a');
            if (a && a.classList.contains('logout-btn')) {
                logout();
                return;
            }
            
            const li = e.target.closest('li');
            const target = li ? li.dataset.target : null;
            if (target) {
                const parentSection = e.target.closest('.view-section');
                if(parentSection) {
                    parentSection.querySelectorAll('.nav-links li').forEach(item => item.classList.remove('active'));
                    li.classList.add('active');
                    parentSection.querySelectorAll('.admin-subview, .chef-subview, .waiter-subview').forEach(el => el.classList.remove('active'));
                    const targetView = document.getElementById(target);
                    
                    // Reset edit state if navigating away from menu
                    if (window.editingOrderId && target !== 'admin-view-menu' && target !== 'waiter-view-menu') {
                        window.editingOrderId = null;
                        currentCart = [];
                        renderCart();
                        const confirmBtn = document.getElementById('btn-confirm-checkout');
                        if (confirmBtn) confirmBtn.innerHTML = '<i class="fas fa-shopping-cart"></i> Sotib olishni tasdiqlash';
                    }
                    
                    if(targetView) {
                        targetView.classList.add('active');
                        if (target === 'admin-view-archived-receipts') fetchAndRenderArchivedReceipts();
                        if (target === 'waiter-view-profile') renderUserProfile('waiter');
                        if (target === 'chef-view-profile') renderUserProfile('chef');
                    }
                }
            }
        });
    });

    document.querySelectorAll('.filter-btn:not(#waiter-menu-filters .filter-btn)').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const role = e.target.closest('.view-section').id;
            if (role === 'admin-dashboard') {
                if (e.target.closest('.admin-orders-filters')) {
                    document.querySelectorAll('.admin-orders-filters .filter-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    adminOrdersCategory = e.target.dataset.status;
                    renderAdminOrders();
                } else if (e.target.closest('.admin-saboy-filters')) {
                    document.querySelectorAll('.admin-saboy-filters .filter-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    adminSaboyCategory = e.target.dataset.status;
                    renderAdminSaboyOrders();
                }
            } else if (role === 'chef-dashboard') {
                if (e.target.closest('.chef-orders-filters')) {
                    document.querySelectorAll('.chef-orders-filters .filter-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    chefOrdersCategory = e.target.dataset.status;
                    renderChefDashboard();
                } else if (e.target.closest('.chef-saboy-filters')) {
                    document.querySelectorAll('.chef-saboy-filters .filter-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    chefSaboyCategory = e.target.dataset.status;
                    renderChefSaboyOrders();
                }
            }
        });
    });
}

function setChefCategory(btn, cat) {
    document.querySelectorAll('#chef-order-filters .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chefOrdersCategory = cat;
    renderChefDashboard();
}

window.openTransferModal = function(orderId) {
    const order = state.orders.find(o => o.id === orderId);
    if(!order) return;
    document.getElementById('transfer-order-id').value = orderId;
    const select = document.getElementById('transfer-chef-select');
    select.innerHTML = '';
    const otherChefs = state.users.filter(u => u.role === 'chef' && u.id !== currentUser.id);
    if(otherChefs.length === 0) {
        select.innerHTML = '<option value="">Boshqa oshpaz yo\'q</option>';
    } else {
        otherChefs.forEach(c => {
            select.innerHTML += `<option value="${c.id}">${c.name}</option>`;
        });
    }
    document.getElementById('transfer-modal').classList.add('active');
};

window.submitTransferOrder = async function() {
    const orderId = document.getElementById('transfer-order-id').value;
    const chefId = document.getElementById('transfer-chef-select').value;
    if(!chefId) { showToast("Oshpaz tanlanmadi", "warning"); return; }
    
    const order = state.orders.find(o => o.id === orderId);
    if(!order) return;
    
    order.chefId = parseInt(chefId);
    closeModal('transfer-modal');
    updateDashboards('chef');
    
    try {
        const payload = { status: order.status, chefId: parseInt(chefId) };
        const res = await fetch(`${API_BASE}/orders/${orderId}/status`, { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        if(res.ok) {
            showToast("Boshqa oshpazga muvaffaqiyatli o'tkazildi!", "success");
            await fetchData(); 
            updateDashboards('chef');
        } else {
            showToast("Xatolik yuz berdi", "danger");
        }
    } catch(err) {
        showToast("Tarmoq xatosi", "danger");
    }
};

document.addEventListener('DOMContentLoaded', init);

// --- Chef My Orders ---
let chefMyDateFilterType = 'all';
let chefMyDateFilterValue = null;
let chefMyStatusFilter = 'all';

window.filterChefMyDate = function(type, value = null) {
    chefMyDateFilterType = type;
    chefMyDateFilterValue = value;
    
    document.querySelectorAll('#chef-my-date-filters .filter-btn').forEach(btn => btn.classList.remove('active'));
    
    if (type === 'all') {
        document.querySelector('#chef-my-date-filters button[data-date="all"]').classList.add('active');
        if(document.getElementById('chef-my-exact-date')) document.getElementById('chef-my-exact-date').value = '';
        if(document.getElementById('chef-my-exact-month')) document.getElementById('chef-my-exact-month').value = '';
    } else if (type === 'exact-date') {
        document.getElementById('chef-my-exact-date').classList.add('active');
        if(document.getElementById('chef-my-exact-month')) document.getElementById('chef-my-exact-month').value = '';
        document.querySelector('#chef-my-date-filters button[data-date="all"]').classList.remove('active');
    } else if (type === 'exact-month') {
        document.getElementById('chef-my-exact-month').classList.add('active');
        if(document.getElementById('chef-my-exact-date')) document.getElementById('chef-my-exact-date').value = '';
        document.querySelector('#chef-my-date-filters button[data-date="all"]').classList.remove('active');
    }
    
    renderChefMyOrders();
};

window.filterChefMyOrders = function(status) {
    chefMyStatusFilter = status;
    document.querySelectorAll('#chef-my-order-filters .filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if(btn.dataset.status === status) btn.classList.add('active');
    });
    renderChefMyOrders();
};

window.renderChefMyOrders = function() {
    if (!currentUser || currentUser.role !== 'chef') return;
    
    let myOrders = state.orders.filter(o => o.chefId != null && String(o.chefId) === String(currentUser.id));
    
    // Yechilgan oylikdan oldingi zakazlarni yashirish
    let userSalaries = state.salaries.filter(s => String(s.userId) === String(currentUser.id));
    userSalaries.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    let lastSalaryTimestamp = userSalaries.length > 0 ? new Date(userSalaries[0].timestamp).getTime() : 0;
    
    myOrders = myOrders.filter(o => new Date(o.timestamp).getTime() > lastSalaryTimestamp);
    
    // Apply Date Filter
    let dateFilteredOrders = myOrders;
    
    if (chefMyDateFilterType === 'exact-date' && chefMyDateFilterValue) {
        dateFilteredOrders = myOrders.filter(o => {
            const d = new Date(o.timestamp);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const localDateStr = yyyy + "-" + mm + "-" + dd;
            return localDateStr === chefMyDateFilterValue;
        });
    } else if (chefMyDateFilterType === 'exact-month' && chefMyDateFilterValue) {
        dateFilteredOrders = myOrders.filter(o => {
            const d = new Date(o.timestamp);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const localMonthStr = yyyy + "-" + mm;
            return localMonthStr === chefMyDateFilterValue;
        });
    }

    // Total income calculation
    const completedOrders = dateFilteredOrders.filter(o => o.status === 'ready' || o.status === 'completed');
    const totalOrdersEl = document.getElementById('chef-my-total-orders');
    const totalIncomeEl = document.getElementById('chef-my-total-income');
    if(totalOrdersEl) totalOrdersEl.textContent = dateFilteredOrders.length;
    if(totalIncomeEl) totalIncomeEl.textContent = "$" + completedOrders.reduce((sum, o) => sum + o.total, 0).toFixed(2);

    let filteredOrders = dateFilteredOrders;
    if (chefMyStatusFilter !== 'all') {
        filteredOrders = dateFilteredOrders.filter(o => o.status === chefMyStatusFilter);
    }
    
    const container = document.getElementById('chef-my-orders-container');
    if(container) {
        container.innerHTML = '';
        if(filteredOrders.length === 0) {
            container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); width: 100%; margin-top: 2rem;">Zakazlar mavjud emas.</p>';
        } else {
            let htmlAcc = '';
            filteredOrders.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
            filteredOrders.forEach(o => {
                let itemsHtml = o.items.map(i => `<b>${i.qty}x</b> ${i.name}`).join(', ');
                let statusColor = 'var(--primary-color)';
                let statusText = 'Yangi';
                if(o.status === 'ready') { statusColor = 'var(--success-color)'; statusText = 'Tayyor'; }
                else if(o.status === 'cancelled') { statusColor = 'var(--danger-color)'; statusText = 'Bekor'; }
                else if(o.status === 'preparing') { statusColor = 'var(--warning-color)'; statusText = 'Jarayonda'; }
                
                htmlAcc += `
                    <div style="background: white; padding: 1.5rem; border-radius: var(--radius-lg); margin-bottom: 1rem; border-left: 5px solid ${statusColor}; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border-top: 1px solid var(--border-color); border-right: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color);">
                        <div style="display:flex; justify-content:space-between; margin-bottom: 0.75rem; align-items: center;">
                            <strong style="font-size: 1.3rem;">Stol ${o.table}</strong>
                            <div style="display:flex; align-items:center;">
                                <span class="badge" style="background: ${statusColor}; color: white; margin-right: 0.5rem; padding: 0.4rem 0.8rem; font-size: 0.9rem;">${statusText}</span>
                                <span style="color:var(--success-color); font-weight:bold; font-size: 1.3rem;">${o.total.toFixed(2)} so'm</span>
                            </div>
                        </div>
                        <p style="font-size:1rem; color:var(--text-secondary); margin-bottom:0.75rem; line-height: 1.5;">${itemsHtml}</p>
                        <small style="color:var(--text-secondary); font-size:0.85rem;"><i class="fas fa-clock mr-2"></i> ${new Date(o.timestamp).toLocaleString()}</small>
                    </div>`;
            });
            container.innerHTML = htmlAcc;
        }
    }
};

window.openAdminSaboyNew = function() {
    document.querySelectorAll('.admin-subview').forEach(v => v.classList.remove('active'));
    document.getElementById('admin-view-saboy-new').classList.add('active');
    
    // Switch to Saboy view internally for cart
    // Waiter uses this.dataset.context, let's just make sure cart logic knows it's an admin saboy order
    window.currentSaboyContext = 'admin';
};

window.viewWaiterReceipt = function(orderId) {
    const order = state.orders.find(o => o.id === orderId);
    if (!order) return;
    
    let itemsHTML = '';
    order.items.forEach(i => {
        let price = i.price || 0;
        let qty = i.qty || 1;
        let sub = price * qty;
        let qtyDisplay = qty + 'x';
        if (i.kg && i.basePrice) {
            qtyDisplay = (qty * i.kg) + 'kg';
        }
        itemsHTML += `
            <tr>
                <td style="padding-bottom: 4px; padding-right: 5px;">${i.name}</td>
                <td style="text-align: center; padding-bottom: 4px; white-space: nowrap;">${qtyDisplay}</td>
                <td style="text-align: right; padding-bottom: 4px; white-space: nowrap;">${sub.toLocaleString()}</td>
            </tr>
        `;
    });

    let receiptHTML = `
    <div style="font-family: 'Courier New', Courier, monospace; font-size: 17px; font-weight: bold; color: black; width: 100%; padding: 0;">
        <div style="text-align: center; margin-bottom: 5px;">
            <img src="chekga.jpg" style="width: 100%; height: auto;" alt="Logo" />
        </div>
        <div style="text-align: center; margin-bottom: 5px;">OFITSIANT CHEKI</div>
        <div style="border-bottom: 1px dashed black; margin-bottom: 5px;"></div>
        <div>Sana: ${new Date(order.timestamp).toLocaleString()}</div>
        <div>Stol: ${order.table}</div>
        <div>Ofitsiant: ${order.waiterId}</div>
        ${order.customerName ? `<div>Mijoz: ${order.customerName}</div>` : ''}
        <div style="border-bottom: 1px dashed black; margin-top: 5px; margin-bottom: 5px;"></div>
        
        <table style="width: 100%; font-size: 16px; font-weight: bold; border-collapse: collapse;">
            <tr>
                <th style="text-align: left; padding-bottom: 4px;">Nomi</th>
                <th style="text-align: center; padding-bottom: 4px;">Soni</th>
                <th style="text-align: right; padding-bottom: 4px;">Narx</th>
            </tr>
            ${itemsHTML}
        </table>
        
        <div style="border-bottom: 1px dashed black; margin-top: 5px; margin-bottom: 5px;"></div>
        <div style="display: flex; justify-content: space-between; font-size: 17px; font-weight: bold;"><span>JAMI:</span> <span>${order.total.toLocaleString()}</span></div>
        <div style="border-bottom: 1px dashed black; margin-top: 5px; margin-bottom: 10px;"></div>
        
        <div style="text-align: center;">
            Xaridingiz uchun rahmat!<br>
            Tel: +998 95 018 19 00
        </div>
    </div>
    `;
    
    document.getElementById('waiter-receipt-content').innerHTML = receiptHTML;
    document.getElementById('waiter-receipt-content').dataset.orderId = orderId;
    document.getElementById('waiter-receipt-content').dataset.table = order.table;
    openModal('waiter-receipt-modal');
};

window.viewWaiterTableReceipt = function(tableName) {
    const tableOrders = state.orders.filter(o => o.table === tableName && o.status !== 'cancelled' && o.status !== 'archived');
    if (tableOrders.length === 0) return;
    
    let aggregatedItems = {};
    let orderIds = [];
    tableOrders.forEach(order => {
        orderIds.push(order.id);
        order.items.forEach(item => {
            if (aggregatedItems[item.id]) {
                aggregatedItems[item.id].qty += item.qty;
            } else {
                aggregatedItems[item.id] = { ...item };
            }
        });
    });
    
    const items = Object.values(aggregatedItems);
    let subtotal = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    
    let itemsText = items.map(i => {
        let price = i.price || 0;
        let qty = i.qty || 1;
        let sub = price * qty;
        let unitLabel = i.unit === 'kg' ? 'kg' : 'dona';
        return `${i.name}\n  ${qty} ${unitLabel} x ${price.toFixed(0)} = ${sub.toFixed(0)} so'm`;
    }).join('\n');

    let text = `================================\n`;
    text += `          GOURMET POS\n`;
    text += `================================\n`;
    text += `Sana: ${new Date().toLocaleString()}\n`;
    text += `Stol: ${tableName}\n`;
    text += `Ofitsiant: ${currentUser ? currentUser.login : ''}\n`;
    text += `--------------------------------\n`;
    text += itemsText + `\n`;
    text += `--------------------------------\n`;
    text += `JAMI: ${subtotal.toFixed(0)} so'm\n`;
    text += `================================\n`;
    text += `       Xaridingiz uchun\n`;
    text += `           Rahmat!\n`;
    text += `================================`;
    
    document.getElementById('waiter-receipt-content').textContent = text;
    document.getElementById('waiter-receipt-content').dataset.orderId = orderIds.join(',');
    document.getElementById('waiter-receipt-content').dataset.table = tableName;
    openModal('waiter-receipt-modal');
};

window.waiterAddOrderToTable = function() {
    const table = document.getElementById('waiter-receipt-content').dataset.table;
    closeModal('waiter-receipt-modal');
    
    document.querySelectorAll('.waiter-subview').forEach(v => v.classList.remove('active'));
    document.getElementById('waiter-view-menu').classList.add('active');
    document.querySelectorAll('.waiter-nav').forEach(n => n.classList.remove('active'));
    document.querySelector('.waiter-nav[data-target="waiter-view-menu"]').classList.add('active');
    
    const tableInput = document.getElementById('table-number');
    if(tableInput) tableInput.value = table;
    
    showToast(`${table} ga qo'shimcha buyurtma oling.`, 'info');
};

window.printWaiterReceipt = async function() {
    const contentEl = document.getElementById('waiter-receipt-content');
    const htmlContent = contentEl.innerHTML;
    const orderIdsStr = contentEl.dataset.orderId;
    if (!htmlContent) return;
    
    // Chek matnini printerga tayyorlash
    const printContainer = document.getElementById('printable-receipt');
    printContainer.innerHTML = htmlContent;
    printContainer.style.display = 'block';
    
    window.print();
    
    setTimeout(() => {
        printContainer.style.display = 'none';
    }, 500);
    
    setTimeout(async () => {
        
        if(orderIdsStr) {
            try {
                const orderIds = orderIdsStr.split(',');
                await Promise.all(orderIds.map(id => fetch(`${API_BASE}/orders/${id}/receipt`, { method: 'PUT' })));
                await fetchData();
                if(currentUser) updateDashboards(currentUser.role);
                showToast("Chek printerga yuborildi", 'success');
            } catch(e) { console.error(e); }
        }
    }, 1000);
};

window.waiterCancelOrder = function() {
    const contentEl = document.getElementById('waiter-receipt-content');
    const orderIdsStr = contentEl.dataset.orderId;
    if (!orderIdsStr) return;
    
    showConfirm("Haqiqatan ham bu zakazni bekor qilmoqchimisiz?", async () => {
        try {
            const orderIds = orderIdsStr.split(',');
            // Optimistic UI updates could be added here if needed, but fetch is quick
            const promises = orderIds.map(id => fetch(`${API_BASE}/orders/${id}`, { method: 'DELETE' }));
            await Promise.all(promises);
            
            showToast("Zakaz bekor qilindi!", "success");
            closeModal('waiter-receipt-modal');
            await fetchData();
            if(currentUser) updateDashboards(currentUser.role);
            if (currentUser && currentUser.role === 'waiter') {
                 renderUserStatsOrders();
            }
        } catch(err) {
            console.error(err);
            showToast("Tarmoq xatosi", "danger");
        }
    });
};

// ==========================================
// Joylar (Map) Logic
// ==========================================

let waiterMapSubTab = 'xonalar'; // 'xonalar' yoki 'zal'

function getMapData(zone, subTab) {
    let prefix, totalItems, icon, labelPrefix;
    
    if (zone === 'choyxona') {
        // Choyxona: xonalar
        prefix = 'ChX';
        totalItems = 18; 
        icon = 'fa-door-closed';
        labelPrefix = 'Xona';
    } else if (zone === 'baliq-xona') {
        if (subTab === 'zal') {
            // Baliq Xona Zal: stollar (10 ta)
            prefix = 'BX-Stol';
            totalItems = 10;
            icon = 'fa-chair';
            labelPrefix = 'Stol';
        } else {
            // Baliq Xona Xonalar: xonalar (15 ta)
            prefix = 'BX-Xona';
            totalItems = 15;
            icon = 'fa-door-closed';
            labelPrefix = 'Xona';
        }
    }
    
    const items = [];
    for(let i=1; i<=totalItems; i++) {
        let name = `${prefix} ${i}`;
        let activeOrder = state.orders.find(o => 
            String(o.table) === name && 
            o.status !== 'cancelled' && 
            o.status !== 'archived' && 
            !o.receiptPrinted
        );
        
        items.push({
            name: name,
            displayName: `${labelPrefix} ${i}`,
            order: activeOrder,
            isBooked: !!activeOrder,
            icon: icon
        });
    }
    return items;
}

window.setWaiterMapSubTab = function(tab) {
    waiterMapSubTab = tab;
    renderWaiterMap();
};

window.renderWaiterMap = function() {
    const container = document.getElementById('waiter-map-container');
    const title = document.getElementById('waiter-zone-title');
    if(!container || !currentUser || currentUser.role !== 'waiter') return;
    
    const zone = currentUser.zone;
    const isBaliq = zone === 'baliq-xona';
    
    if(title) title.textContent = isBaliq ? 'Baliq Xona' : 'Choyxona';
    
    // Sub-tab tugmalari (faqat Baliq Xona uchun)
    let subTabsHtml = '';
    if (isBaliq) {
        const xonaCount = getMapData(zone, 'xonalar').filter(i => i.isBooked).length;
        const zalCount = getMapData(zone, 'zal').filter(i => i.isBooked).length;
        subTabsHtml = `
            <div class="map-subtabs">
                <button class="map-subtab-btn ${waiterMapSubTab === 'xonalar' ? 'active' : ''}" onclick="setWaiterMapSubTab('xonalar')">
                    <i class="fas fa-door-closed"></i> Xonalar
                    <span class="map-subtab-count">${xonaCount}/15 band</span>
                </button>
                <button class="map-subtab-btn ${waiterMapSubTab === 'zal' ? 'active' : ''}" onclick="setWaiterMapSubTab('zal')">
                    <i class="fas fa-chair"></i> Zal (Stollar)
                    <span class="map-subtab-count">${zalCount}/10 band</span>
                </button>
            </div>
        `;
    } else {
        // Choyxona uchun statistika
        const choyxonaData = getMapData(zone, 'xonalar');
        const bandCount = choyxonaData.filter(i => i.isBooked).length;
        subTabsHtml = `
            <div class="map-stats-bar">
                <div class="map-stat">
                    <span class="map-stat-dot free-dot"></span>
                    Bo'sh: <strong>${18 - bandCount}</strong>
                </div>
                <div class="map-stat">
                    <span class="map-stat-dot booked-dot"></span>
                    Band: <strong>${bandCount}</strong>
                </div>
            </div>
        `;
    }
    
    const subTab = isBaliq ? waiterMapSubTab : 'xonalar';
    const data = getMapData(zone, subTab);
    
    let cardsHtml = data.map(item => {
        const statusClass = item.isBooked ? 'booked' : 'free';
        const statusText = item.isBooked ? 'Band' : 'Bo\'sh';
        const statusIcon = item.isBooked ? 'fa-lock' : 'fa-lock-open';
        
        let orderInfo = '';
        if (item.isBooked && item.order) {
            const customerName = item.order.customerName ? `<div class="map-card-customer"><i class="fas fa-user"></i> ${item.order.customerName}</div>` : '';
            const statusLabel = item.order.status === 'pending' ? '⏳ Kutilmoqda' : 
                               item.order.status === 'cooking' ? '🍳 Tayyorlanmoqda' : 
                               item.order.status === 'ready' ? '✅ Tayyor' : item.order.status;
            orderInfo = `
                <div class="map-card-order-info">
                    ${customerName}
                    <div class="map-card-total">${Number(item.order.total).toLocaleString()} so'm</div>
                    <div class="map-card-status-label">${statusLabel}</div>
                </div>
            `;
        }
        
        return `
            <div class="map-card ${statusClass} type-${subTab}" onclick="handleMapClick('${item.name}', '${item.order ? item.order.id : ''}')">
                <span class="status-badge"><i class="fas ${statusIcon}"></i> ${statusText}</span>
                
                <h3>${item.displayName}</h3>
                ${orderInfo}
            </div>
        `;
    }).join('');
    
    container.innerHTML = subTabsHtml + `<div class="map-grid">${cardsHtml}</div>`;
};

let adminMapZone = 'baliq-xona';
let adminMapSubTab = 'xonalar';

window.setAdminMapZone = function(zone) {
    adminMapZone = zone;
    adminMapSubTab = 'xonalar';
    renderAdminMap();
};

window.setAdminMapSubTab = function(tab) {
    adminMapSubTab = tab;
    renderAdminMap();
};

window.renderAdminMap = function(zone) {
    const container = document.getElementById('admin-map-container');
    if(!container) return;
    
    if(zone) adminMapZone = zone;
    
    const isBaliq = adminMapZone === 'baliq-xona';
    
    // Zone tabs
    document.querySelectorAll('#admin-view-map .zone-filter-btn').forEach(btn => btn.classList.remove('active'));
    const zoneBtn = document.getElementById('admin-map-btn-' + (adminMapZone === 'choyxona' ? 'choyxona' : 'baliq'));
    if(zoneBtn) zoneBtn.classList.add('active');
    
    // Sub-tab HTML for Baliq Xona
    let subTabsHtml = '';
    if (isBaliq) {
        const xonaCount = getMapData(adminMapZone, 'xonalar').filter(i => i.isBooked).length;
        const zalCount = getMapData(adminMapZone, 'zal').filter(i => i.isBooked).length;
        subTabsHtml = `
            <div class="map-subtabs">
                <button class="map-subtab-btn ${adminMapSubTab === 'xonalar' ? 'active' : ''}" onclick="setAdminMapSubTab('xonalar')">
                    <i class="fas fa-door-closed"></i> Xonalar
                    <span class="map-subtab-count">${xonaCount}/15 band</span>
                </button>
                <button class="map-subtab-btn ${adminMapSubTab === 'zal' ? 'active' : ''}" onclick="setAdminMapSubTab('zal')">
                    <i class="fas fa-chair"></i> Zal (Stollar)
                    <span class="map-subtab-count">${zalCount}/10 band</span>
                </button>
            </div>
        `;
    } else {
        const choyxonaData = getMapData(adminMapZone, 'xonalar');
        const bandCount = choyxonaData.filter(i => i.isBooked).length;
        subTabsHtml = `
            <div class="map-stats-bar">
                <div class="map-stat">
                    <span class="map-stat-dot free-dot"></span>
                    Bo'sh: <strong>${18 - bandCount}</strong>
                </div>
                <div class="map-stat">
                    <span class="map-stat-dot booked-dot"></span>
                    Band: <strong>${bandCount}</strong>
                </div>
            </div>
        `;
    }
    
    const subTab = isBaliq ? adminMapSubTab : 'xonalar';
    const data = getMapData(adminMapZone, subTab);
    
    let cardsHtml = data.map(item => {
        const statusClass = item.isBooked ? 'booked' : 'free';
        const statusText = item.isBooked ? 'Band' : 'Bo\'sh';
        const statusIcon = item.isBooked ? 'fa-lock' : 'fa-lock-open';
        
        let orderInfo = '';
        if (item.isBooked && item.order) {
            const customerName = item.order.customerName ? `<div class="map-card-customer"><i class="fas fa-user"></i> ${item.order.customerName}</div>` : '';
            const statusLabel = item.order.status === 'pending' ? '⏳ Kutilmoqda' : 
                               item.order.status === 'cooking' ? '🍳 Tayyorlanmoqda' : 
                               item.order.status === 'ready' ? '✅ Tayyor' : item.order.status;
            orderInfo = `
                <div class="map-card-order-info">
                    ${customerName}
                    <div class="map-card-total">${Number(item.order.total).toLocaleString()} so'm</div>
                    <div class="map-card-status-label">${statusLabel}</div>
                </div>
            `;
        }
        
        return `
            <div class="map-card ${statusClass} type-${subTab}" onclick="${item.isBooked ? `adminCheckoutTable('${item.name}')` : `openAdminTableOrder('${item.name}')`}">
                <span class="status-badge"><i class="fas ${statusIcon}"></i> ${statusText}</span>
                
                <h3>${item.displayName}</h3>
                ${orderInfo}
            </div>
        `;
    }).join('');
    
    container.innerHTML = subTabsHtml + `<div class="map-grid">${cardsHtml}</div>`;
};

window.adminCheckoutTable = function(tableName) {
    document.querySelectorAll('.admin-subview').forEach(v => v.classList.remove('active'));
    document.getElementById('admin-view-receipts').classList.add('active');
    document.querySelectorAll('.admin-nav').forEach(n => n.classList.remove('active'));
    
    // Check if there is a nav link to highlight
    const navLink = document.querySelector('.admin-nav[data-target="admin-view-receipts"]');
    if (navLink) navLink.classList.add('active');
    
    // Automatically select the table for checkout
    renderReceiptPreview(tableName);
};

window.handleMapClick = function(tableName, orderId) {
    if(orderId) {
        // Band - Umumiy chekni ko'rsatish
        viewWaiterTableReceipt(tableName);
    } else {
        // Bo'sh - Menyu ochiladi va stol raqami oldindan qo'yiladi
        document.querySelectorAll('.waiter-subview').forEach(v => v.classList.remove('active'));
        document.getElementById('waiter-view-menu').classList.add('active');
        document.querySelectorAll('.waiter-nav').forEach(n => n.classList.remove('active'));
        document.querySelector('.waiter-nav[data-target="waiter-view-menu"]').classList.add('active');
        
        window.resetEditState();
        
        // Stol raqamini oldindan qo'yish
        const tableInput = document.getElementById('table-number');
        if(tableInput) tableInput.value = tableName;
        
        showToast(`${tableName} tanlandi. Endi zakaz oling.`, 'info');
    }
};

window.openAdminTableOrder = function(tableName) {
    document.querySelectorAll('.admin-subview').forEach(v => v.classList.remove('active'));
    document.getElementById('admin-view-saboy-new').classList.add('active'); 
    window.currentSaboyContext = 'admin-table'; 
    window.resetEditState();
    const tableInput = document.getElementById('table-number');
    if(tableInput) {
        tableInput.value = tableName;
    }
    const dineInRadio = document.querySelector('input[name="order-type"][value="dine_in"]');
    if (dineInRadio) {
        dineInRadio.checked = true;
        toggleOrderType();
    }
    showToast(`${tableName} tanlandi. Endi zakaz oling.`, 'info');
};
