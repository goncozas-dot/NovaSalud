const state = { products: [], sales: [], cart: new Map(), currentView: "dashboard", user: null };
const currency = new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" });
const productIcons = ["✚", "◉", "✿", "✦"];
let toastTimer;

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const money = (value) => currency.format(value);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !["/api/login", "/api/session"].includes(url)) showLogin();
    throw new Error(data.error || "No se pudo completar la solicitud.");
  }
  return data;
}

function showLogin() {
  state.user = null;
  setAuthMode("login");
  $("#app-shell").hidden = true;
  $("#login-screen").hidden = false;
}

function setAuthMode(mode) {
  const isRegister = mode === "register";
  $("#login-form").hidden = isRegister;
  $("#register-form").hidden = !isRegister;
  $("#login-tab").classList.toggle("active", !isRegister);
  $("#register-tab").classList.toggle("active", isRegister);
  $("#login-tab").setAttribute("aria-selected", String(!isRegister));
  $("#register-tab").setAttribute("aria-selected", String(isRegister));
}

function showApp(user = state.user) {
  state.user = user;
  const name = user?.name || "Administrador";
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase("es") || "NS";
  $("#profile-name").textContent = name;
  $("#profile-role").textContent = user?.role || "Administrador";
  $("#profile-avatar").textContent = initials;
  $("#top-avatar").textContent = initials;
  $("#login-screen").hidden = true;
  $("#app-shell").hidden = false;
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("es-PE", { hour: "2-digit", minute: "2-digit" }).format(new Date(date));
}

function formatDate(date) {
  return new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(date));
}

function statusMarkup(product) {
  const low = product.stock <= product.minStock;
  return `<span class="stock-status ${low ? "low" : "good"}"><i class="live-dot status-dot ${low ? "low" : "good"}"></i>${low ? "Stock bajo" : "Disponible"}</span>`;
}

function renderDashboard() {
  const today = new Date().toDateString();
  const todaysSales = state.sales.filter((sale) => new Date(sale.date).toDateString() === today);
  const revenue = todaysSales.reduce((sum, sale) => sum + sale.total, 0);
  const startOfWeek = new Date();
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(startOfWeek);
    date.setDate(startOfWeek.getDate() + index);
    return date;
  });
  const dailyRevenue = days.map((day) => state.sales
    .filter((sale) => new Date(sale.date).toDateString() === day.toDateString())
    .reduce((sum, sale) => sum + sale.total, 0));
  const weeklyRevenue = dailyRevenue.reduce((sum, amount) => sum + amount, 0);
  const chartMaximum = Math.max(100, Math.ceil(Math.max(...dailyRevenue) / 100) * 100);
  $("#chart-y-labels").innerHTML = [1, 0.75, 0.5, 0.25, 0].map((fraction) => `<span>S/ ${Math.round(chartMaximum * fraction)}</span>`).join("");
  $("#sales-bars").innerHTML = days.map((day, index) => {
    const level = dailyRevenue[index] ? Math.min(8, Math.ceil(dailyRevenue[index] / chartMaximum * 8)) : 0;
    const label = day.toDateString() === today ? "Hoy" : new Intl.DateTimeFormat("es-PE", { weekday: "short" }).format(day).replace(".", "");
    return `<div><i class="bar-${level} ${label === "Hoy" ? "bar-today" : ""}"></i><span>${label}</span></div>`;
  }).join("");
  const lowStock = state.products.filter((product) => product.stock <= product.minStock);
  $("#metric-revenue").textContent = money(revenue);
  $("#metric-sales").textContent = todaysSales.length;
  $("#metric-products").textContent = state.products.length;
  $("#metric-lowstock").innerHTML = `${lowStock.length} <small>productos</small>`;
  $("#chart-revenue").textContent = money(weeklyRevenue);
  $("#alert-counter").textContent = lowStock.length;
  $("#nav-alert-count").textContent = lowStock.length;
  $("#alert-list").innerHTML = lowStock.length
    ? lowStock.slice(0, 3).map((product, index) => `<div class="alert-item"><span class="product-thumb">${productIcons[index % productIcons.length]}</span><span class="alert-info"><strong>${escapeHTML(product.name)}</strong><small>${escapeHTML(product.category)} · mínimo ${product.minStock} un.</small></span><span class="stock-pill">${product.stock} un.</span></div>`).join("")
    : `<div class="empty-cart"><strong>¡Todo en orden!</strong><small>No hay productos por reponer.</small></div>`;
  $("#recent-sales-body").innerHTML = state.sales.slice(0, 5).map((sale) => `<tr><td class="sale-id">#${escapeHTML(sale.id)}</td><td class="customer-cell">${escapeHTML(sale.customer)}</td><td>${sale.items.length} producto${sale.items.length === 1 ? "" : "s"}</td><td><span class="payment-tag">${escapeHTML(sale.payment)}</span></td><td>${formatTime(sale.date)}</td><td class="right"><strong>${money(sale.total)}</strong></td></tr>`).join("");
}

function renderInventory() {
  const query = $("#inventory-search").value.trim().toLocaleLowerCase("es");
  const filter = $("#stock-filter").value;
  const filtered = state.products.filter((product) => {
    const matchesText = `${product.name} ${product.category} ${product.barcode} ${product.lot}`.toLocaleLowerCase("es").includes(query);
    const matchesStatus = filter === "all" || (filter === "low" ? product.stock <= product.minStock : product.stock > product.minStock);
    return matchesText && matchesStatus;
  });
  const expiring = state.products.filter((product) => {
    if (!product.expiry) return false;
    const days = (new Date(`${product.expiry}T00:00:00`) - new Date()) / 86400000;
    return days >= 0 && days <= 90;
  }).length;
  $("#inventory-total").textContent = state.products.length;
  $("#inventory-low").textContent = state.products.filter((product) => product.stock <= product.minStock).length;
  $("#inventory-categories").textContent = new Set(state.products.map((product) => product.category)).size;
  $("#inventory-expiring").textContent = expiring;
  $("#inventory-showing").textContent = `Mostrando ${filtered.length} de ${state.products.length} productos`;
  $("#inventory-body").innerHTML = filtered.length ? filtered.map((product, index) => `<tr>
    <td><div class="inventory-product"><span class="product-thumb">${productIcons[index % productIcons.length]}</span><span><strong>${escapeHTML(product.name)}</strong><small>${escapeHTML(product.barcode || "Sin código")}</small></span></div></td>
    <td>${escapeHTML(product.category)}</td><td>${escapeHTML(product.lot || "—")}</td><td>${product.expiry ? formatDate(`${product.expiry}T00:00:00`) : "—"}</td>
    <td><strong>${product.stock}</strong> <span class="stock-min">/ mín. ${product.minStock}</span></td><td>${money(product.price)}</td><td>${statusMarkup(product)}</td><td><button class="restock-button" data-restock="${escapeHTML(product.id)}">Reponer</button></td></tr>`).join("") : `<tr><td colspan="8" class="empty-row">No se encontraron productos.</td></tr>`;
}

function renderCatalog() {
  const query = $("#sale-search").value.trim().toLocaleLowerCase("es");
  const products = state.products.filter((product) => `${product.name} ${product.barcode}`.toLocaleLowerCase("es").includes(query));
  $("#sale-product-list").innerHTML = products.length ? products.map((product, index) => `<div class="sale-product">
    <span class="product-thumb">${productIcons[index % productIcons.length]}</span>
    <span class="sale-product-info"><strong>${escapeHTML(product.name)}</strong><small>${escapeHTML(product.category)} · ${product.stock} disponibles</small></span>
    <span class="sale-product-price">${money(product.price)}</span>
    <button class="add-to-cart" data-add="${escapeHTML(product.id)}" aria-label="Agregar ${escapeHTML(product.name)}" ${product.stock < 1 ? "disabled" : ""}>＋</button>
  </div>`).join("") : `<div class="empty-cart"><strong>No encontramos productos</strong><small>Prueba con otro nombre o código.</small></div>`;
}

function renderCart() {
  const items = [...state.cart.entries()];
  const total = items.reduce((sum, [id, quantity]) => {
    const product = state.products.find((entry) => entry.id === id);
    return sum + (product ? product.price * quantity : 0);
  }, 0);
  const itemCount = items.reduce((sum, [, quantity]) => sum + quantity, 0);
  $("#cart-count").textContent = `${itemCount} producto${itemCount === 1 ? "" : "s"}`;
  $("#cart-subtotal").textContent = money(total);
  $("#cart-tax").textContent = money(total - total / 1.18);
  $("#cart-total").textContent = money(total);
  $("#cart-items").innerHTML = items.length ? items.map(([id, quantity]) => {
    const product = state.products.find((entry) => entry.id === id);
    if (!product) return "";
    return `<div class="cart-item"><strong>${escapeHTML(product.name)}</strong><span class="line-total">${money(product.price * quantity)}</span><span class="quantity-control"><button data-quantity="${escapeHTML(id)}" data-change="-1" aria-label="Disminuir cantidad">−</button>${quantity}<button data-quantity="${escapeHTML(id)}" data-change="1" aria-label="Aumentar cantidad" ${quantity >= product.stock ? "disabled" : ""}>＋</button></span><button class="remove-item" data-remove="${escapeHTML(id)}">Quitar</button></div>`;
  }).join("") : `<div class="empty-cart"><span>▧</span><strong>Tu venta está vacía</strong><small>Agrega productos del catálogo para comenzar.</small></div>`;
}

function renderHistory() {
  const query = $("#history-search").value.trim().toLocaleLowerCase("es");
  const filtered = state.sales.filter((sale) => `${sale.id} ${sale.customer}`.toLocaleLowerCase("es").includes(query));
  const revenue = state.sales.reduce((sum, sale) => sum + sale.total, 0);
  const payments = state.sales.reduce((counts, sale) => counts.set(sale.payment, (counts.get(sale.payment) || 0) + 1), new Map());
  $("#history-count").textContent = state.sales.length;
  $("#history-revenue").textContent = money(revenue);
  $("#history-payment").textContent = payments.size ? [...payments.entries()].sort((a, b) => b[1] - a[1])[0][0] : "—";
  $("#history-body").innerHTML = filtered.length ? filtered.map((sale) => `<tr><td class="sale-id">#${escapeHTML(sale.id)}</td><td>${formatDate(sale.date)} · ${formatTime(sale.date)}</td><td class="customer-cell">${escapeHTML(sale.customer)}</td><td>${sale.items.map((item) => `${item.quantity} × ${escapeHTML(item.name)}`).join(", ")}</td><td><span class="payment-tag">${escapeHTML(sale.payment)}</span></td><td class="right"><strong>${money(sale.total)}</strong></td></tr>`).join("") : `<tr><td colspan="6" class="empty-row">No hay ventas que coincidan con la búsqueda.</td></tr>`;
}

function renderAll() {
  renderDashboard();
  renderInventory();
  renderCatalog();
  renderCart();
  renderHistory();
}

async function refreshData() {
  const [data, sales] = await Promise.all([api("/api/dashboard"), api("/api/sales")]);
  state.products = data.products;
  state.sales = sales.sales;
  renderAll();
}

function navigate(view) {
  state.currentView = view;
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
  document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  const names = { dashboard: "Resumen", inventory: "Inventario", sales: "Nueva venta", history: "Historial de ventas" };
  $("#breadcrumb-current").textContent = names[view];
  $("#sidebar").classList.remove("open");
  if (view === "inventory") renderInventory();
  if (view === "sales") { renderCatalog(); renderCart(); }
}

function addToCart(id) {
  const product = state.products.find((entry) => entry.id === id);
  const quantity = state.cart.get(id) || 0;
  if (!product || quantity >= product.stock) {
    showToast("No hay stock suficiente para agregar más unidades.", true);
    return;
  }
  state.cart.set(id, quantity + 1);
  renderCart();
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#login-error");
  error.textContent = "";
  const form = new FormData(event.currentTarget);
  try {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    showApp(data.user);
    await refreshData();
  } catch (problem) {
    error.textContent = problem.message;
  }
});

document.querySelectorAll("[data-auth-tab]").forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.authTab)));

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const registrationForm = event.currentTarget;
  const error = $("#register-error");
  error.textContent = "";
  const form = new FormData(registrationForm);
  const password = form.get("password");
  if (password !== form.get("passwordConfirm")) {
    error.textContent = "Las contraseñas no coinciden.";
    return;
  }
  try {
    const data = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        username: form.get("username"),
        password
      })
    });
    registrationForm.reset();
    showApp(data.user);
    await refreshData();
  } catch (problem) {
    error.textContent = problem.message;
  }
});

$("#logout-button").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
});

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.go)));
$("#mobile-menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#inventory-search").addEventListener("input", renderInventory);
$("#stock-filter").addEventListener("change", renderInventory);
let restockProductId = "";
$("#inventory-body").addEventListener("click", (event) => {
  const button = event.target.closest("[data-restock]");
  if (!button) return;
  restockProductId = button.dataset.restock;
  const product = state.products.find((entry) => entry.id === restockProductId);
  $("#restock-product-name").textContent = product ? `${product.name} · Stock actual: ${product.stock} unidades` : "";
  $("#restock-error").textContent = "";
  $("#restock-quantity").value = "";
  $("#restock-dialog").showModal();
  $("#restock-quantity").focus();
});
$("#cancel-restock").addEventListener("click", () => $("#restock-dialog").close());
$("#restock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#restock-error").textContent = "";
  const quantity = Number(new FormData(event.currentTarget).get("quantity"));
  try {
    await api(`/api/products/${encodeURIComponent(restockProductId)}/restock`, { method: "POST", body: JSON.stringify({ quantity }) });
    $("#restock-dialog").close();
    await refreshData();
    showToast("Reposición registrada y stock actualizado.");
  } catch (error) {
    $("#restock-error").textContent = error.message;
  }
});
$("#sale-search").addEventListener("input", renderCatalog);
$("#history-search").addEventListener("input", renderHistory);
$("#sale-product-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-add]");
  if (button) addToCart(button.dataset.add);
});
$("#cart-items").addEventListener("click", (event) => {
  const quantityButton = event.target.closest("[data-quantity]");
  const removeButton = event.target.closest("[data-remove]");
  if (removeButton) state.cart.delete(removeButton.dataset.remove);
  if (quantityButton) {
    const id = quantityButton.dataset.quantity;
    const next = (state.cart.get(id) || 0) + Number(quantityButton.dataset.change);
    if (next < 1) state.cart.delete(id);
    else state.cart.set(id, next);
  }
  renderCart();
});

$("#toggle-product-form").addEventListener("click", () => {
  $("#product-form").hidden = !$("#product-form").hidden;
  $("#product-form").scrollIntoView({ behavior: "smooth", block: "nearest" });
});
document.querySelectorAll(".close-form").forEach((button) => button.addEventListener("click", () => { $("#product-form").hidden = true; }));
$("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#product-error").textContent = "";
  const values = Object.fromEntries(new FormData(event.currentTarget));
  values.price = Number(values.price);
  values.stock = Number(values.stock);
  values.minStock = Number(values.minStock);
  try {
    await api("/api/products", { method: "POST", body: JSON.stringify(values) });
    event.currentTarget.reset();
    $("#product-form").hidden = true;
    await refreshData();
    showToast("Producto agregado al inventario.");
  } catch (error) {
    $("#product-error").textContent = error.message;
  }
});

$("#checkout-button").addEventListener("click", async () => {
  const error = $("#sale-error");
  error.textContent = "";
  const items = [...state.cart.entries()].map(([productId, quantity]) => ({ productId, quantity }));
  if (!items.length) {
    error.textContent = "Agrega al menos un producto para registrar la venta.";
    return;
  }
  $("#checkout-button").disabled = true;
  try {
    const data = await api("/api/sales", {
      method: "POST",
      body: JSON.stringify({ customer: $("#sale-customer").value.trim(), payment: $("#payment-method").value, items })
    });
    state.cart.clear();
    $("#sale-customer").value = "";
    await refreshData();
    navigate("history");
    showToast(`Venta #${data.sale.id} registrada. El inventario se actualizó.`);
  } catch (problem) {
    error.textContent = problem.message;
    await refreshData();
  } finally {
    $("#checkout-button").disabled = false;
  }
});

$("#help-button").addEventListener("click", () => showToast("Para soporte, comunícate con el administrador de la botica."));
$("#today-label").textContent = new Intl.DateTimeFormat("es-PE", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date());
$("#dashboard-date").textContent = new Intl.DateTimeFormat("es-PE", { weekday: "long", day: "numeric", month: "long" }).format(new Date()).toLocaleUpperCase("es");
$("#login-screen").hidden = true;
api("/api/session").then(async (session) => {
  showApp(session.user);
  await refreshData();
}).catch(() => showLogin());
