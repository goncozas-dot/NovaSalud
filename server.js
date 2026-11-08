const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const DATA_FILE = path.join(__dirname, "data", "store.json");
const USERS_FILE = path.join(__dirname, "data", "users.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const sessions = new Map();
let mutationQueue = Promise.resolve();
let usersWriteQueue = Promise.resolve();
const passwordSalt = crypto.randomBytes(16);
const configuredPassword = process.env.BOTICA_PASSWORD || "NovaSalud2026!";
const passwordHash = crypto.scryptSync(configuredPassword, passwordSalt, 64);
let writeQueue = Promise.resolve();

async function loadStore() {
  const content = await fs.readFile(DATA_FILE, "utf8");
  return JSON.parse(content);
}

async function loadUsers() {
  const content = await fs.readFile(USERS_FILE, "utf8");
  return JSON.parse(content);
}

async function initializeDataFiles() {
  const initialFiles = [
    [DATA_FILE, { products: [], sales: [] }],
    [USERS_FILE, { users: [] }]
  ];

  for (const [filePath, contents] of initialFiles) {
    try {
      await fs.writeFile(filePath, `${JSON.stringify(contents, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

function saveUsers(userStore) {
  const write = usersWriteQueue.then(async () => {
    const temporaryFile = `${USERS_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(userStore, null, 2)}\n`, "utf8");
    await fs.rename(temporaryFile, USERS_FILE);
  });
  usersWriteQueue = write.catch(() => {});
  return write;
}

function saveStore(store) {
  const write = writeQueue.then(async () => {
    const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await fs.rename(temporaryFile, DATA_FILE);
  });
  writeQueue = write.catch(() => {});
  return write;
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("La solicitud es demasiado grande."), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("El formato de la solicitud no es válido."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function getSession(request) {
  const cookie = request.headers.cookie || "";
  const token = cookie.match(/(?:^|;\s*)ns_session=([a-f0-9]+)/)?.[1];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, user: session.user };
}

function requireSession(request, response) {
  if (getSession(request)) return true;
  sendJson(response, 401, { error: "Tu sesión venció. Inicia sesión nuevamente." });
  return false;
}

function isValidText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

function money(value) {
  return Math.round(value * 100) / 100;
}

function serveStatic(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const resolvedPath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!resolvedPath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403).end("Prohibido");
    return;
  }
  const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
  fs.readFile(resolvedPath).then((content) => {
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(resolvedPath)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    });
    response.end(content);
  }).catch(() => response.writeHead(404).end("No encontrado"));
}

async function handleApi(request, response, pathname) {
  if (request.method === "POST" && pathname === "/api/register") {
    const body = await readBody(request);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const requestedRole = body.role;
    if (!/^[a-z0-9._-]{3,30}$/.test(username) ||
        !isValidText(name, 80) || name.length < 2 ||
        typeof body.password !== "string" || body.password.length < 10 || body.password.length > 128 ||
        (requestedRole !== undefined && requestedRole !== "Vendedor")) {
      sendJson(response, 400, { error: "Ingresa un nombre, usuario válido y contraseña de al menos 10 caracteres. Solo se permite el rol Vendedor." });
      return;
    }

    const adminUsername = (process.env.BOTICA_USER || "admin").trim().toLowerCase();
    const userStore = await loadUsers();
    if (username === adminUsername || userStore.users.some((user) => user.username === username)) {
      sendJson(response, 409, { error: "Ese nombre de usuario ya está registrado." });
      return;
    }

    const salt = crypto.randomBytes(16);
    const user = {
      id: crypto.randomUUID(),
      username,
      name,
      role: "Vendedor",
      passwordSalt: salt.toString("hex"),
      passwordHash: crypto.scryptSync(body.password, salt, 64).toString("hex"),
      createdAt: new Date().toISOString()
    };
    userStore.users.push(user);
    await saveUsers(userStore);

    const publicUser = { name: user.name, role: user.role, username: user.username };
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, user: publicUser });
    sendJson(response, 201, { user: publicUser }, {
      "Set-Cookie": `ns_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/login") {
    const body = await readBody(request);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const suppliedPassword = typeof body.password === "string" ? body.password : "";
    if (!username || suppliedPassword.length > 128) {
      sendJson(response, 401, { error: "Usuario o contraseña incorrectos." });
      return;
    }
    const adminUsername = (process.env.BOTICA_USER || "admin").trim().toLowerCase();
    const userStore = await loadUsers();
    const registeredUser = userStore.users.find((user) => user.username === username);
    const salt = username === adminUsername
      ? passwordSalt
      : registeredUser ? Buffer.from(registeredUser.passwordSalt, "hex") : passwordSalt;
    const expectedHash = username === adminUsername
      ? passwordHash
      : registeredUser ? Buffer.from(registeredUser.passwordHash, "hex") : passwordHash;
    const suppliedHash = crypto.scryptSync(suppliedPassword, salt, 64);
    const passwordMatches = crypto.timingSafeEqual(expectedHash, suppliedHash);
    const userMatches = username === adminUsername || Boolean(registeredUser);
    if (!userMatches || !passwordMatches) {
      sendJson(response, 401, { error: "Usuario o contraseña incorrectos." });
      return;
    }
    const user = username === adminUsername
      ? { name: "Administrador", role: "Administrador", username: adminUsername }
      : { name: registeredUser.name, role: registeredUser.role, username: registeredUser.username };
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, user });
    sendJson(response, 200, { user }, {
      "Set-Cookie": `ns_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/logout") {
    const session = getSession(request);
    if (session) sessions.delete(session.token);
    sendJson(response, 200, { ok: true }, { "Set-Cookie": "ns_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    return;
  }

  if (request.method === "GET" && pathname === "/api/session") {
    const session = getSession(request);
    if (!session) {
      sendJson(response, 401, { error: "Inicia sesión para continuar." });
      return;
    }
    sendJson(response, 200, { user: session.user });
    return;
  }

  if (!requireSession(request, response)) return;
  const store = await loadStore();

  if (request.method === "GET" && pathname === "/api/dashboard") {
    const today = new Date().toDateString();
    const todaysSales = store.sales.filter((sale) => new Date(sale.date).toDateString() === today);
    sendJson(response, 200, {
      products: store.products,
      recentSales: store.sales.slice(0, 8),
      stats: {
        productCount: store.products.length,
        lowStockCount: store.products.filter((product) => product.stock <= product.minStock).length,
        todaySalesCount: todaysSales.length,
        todayRevenue: money(todaysSales.reduce((sum, sale) => sum + sale.total, 0))
      }
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/products") {
    sendJson(response, 200, { products: store.products });
    return;
  }

  if (request.method === "POST" && pathname === "/api/products") {
    const body = await readBody(request);
    const price = Number(body.price);
    const stock = Number(body.stock);
    const minStock = Number(body.minStock);
    if (!isValidText(body.name, 100) || !isValidText(body.category, 60) ||
        !Number.isFinite(price) || price <= 0 || !Number.isInteger(stock) || stock < 0 ||
        !Number.isInteger(minStock) || minStock < 0 ||
        (body.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(body.expiry))) {
      sendJson(response, 400, { error: "Revisa el nombre, categoría, precio, stock, mínimo y vencimiento." });
      return;
    }
    const product = {
      id: `p-${crypto.randomUUID()}`,
      name: body.name.trim(),
      category: body.category.trim(),
      price: money(price),
      stock,
      minStock,
      lot: isValidText(body.lot, 40) ? body.lot.trim() : "Sin lote",
      expiry: body.expiry || "",
      barcode: isValidText(body.barcode, 40) ? body.barcode.trim() : ""
    };
    store.products.push(product);
    await saveStore(store);
    sendJson(response, 201, { product });
    return;
  }

  const restockMatch = pathname.match(/^\/api\/products\/(p-[a-zA-Z0-9-]+)\/restock$/);
  if (request.method === "POST" && restockMatch) {
    const body = await readBody(request);
    const quantity = Number(body.quantity);
    const product = store.products.find((entry) => entry.id === restockMatch[1]);
    if (!product) {
      sendJson(response, 404, { error: "No se encontró el producto." });
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
      sendJson(response, 400, { error: "Ingresa una cantidad de reposición válida." });
      return;
    }
    product.stock += quantity;
    await saveStore(store);
    sendJson(response, 200, { product });
    return;
  }

  if (request.method === "GET" && pathname === "/api/sales") {
    sendJson(response, 200, { sales: store.sales });
    return;
  }

  if (request.method === "POST" && pathname === "/api/sales") {
    const body = await readBody(request);
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50 ||
        !["Efectivo", "Yape / Plin", "Tarjeta"].includes(body.payment) ||
        (body.customer !== undefined && !isValidText(body.customer, 100))) {
      sendJson(response, 400, { error: "Revisa el cliente, el medio de pago y los productos de la venta." });
      return;
    }
    const quantities = new Map();
    for (const item of body.items) {
      if (typeof item.productId !== "string" || !Number.isInteger(item.quantity) || item.quantity < 1) {
        sendJson(response, 400, { error: "Cada producto debe tener una cantidad válida." });
        return;
      }
      quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
    }
    const saleItems = [];
    for (const [productId, quantity] of quantities) {
      const product = store.products.find((entry) => entry.id === productId);
      if (!product) {
        sendJson(response, 400, { error: "Uno de los productos ya no está disponible." });
        return;
      }
      if (product.stock < quantity) {
        sendJson(response, 409, { error: `Stock insuficiente de ${product.name}. Disponible: ${product.stock}.` });
        return;
      }
      saleItems.push({ productId, name: product.name, quantity, unitPrice: product.price });
    }
    for (const item of saleItems) {
      const product = store.products.find((entry) => entry.id === item.productId);
      product.stock -= item.quantity;
    }
    const total = money(saleItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
    const sale = {
      id: `v-${Date.now().toString().slice(-8)}`,
      date: new Date().toISOString(),
      customer: typeof body.customer === "string" && body.customer.trim() ? body.customer.trim() : "Cliente general",
      payment: body.payment,
      items: saleItems,
      total
    };
    store.sales.unshift(sale);
    await saveStore(store);
    sendJson(response, 201, { sale, products: store.products });
    return;
  }

  sendJson(response, 404, { error: "Ruta no encontrada." });
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname.startsWith("/api/")) {
      if (request.method === "POST" && (pathname === "/api/register" || pathname === "/api/products" || pathname === "/api/sales" || /^\/api\/products\/p-[a-zA-Z0-9-]+\/restock$/.test(pathname))) {
        const operation = mutationQueue.then(() => handleApi(request, response, pathname));
        mutationQueue = operation.catch(() => {});
        await operation;
      } else {
        await handleApi(request, response, pathname);
      }
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end("Método no permitido");
      return;
    }
    serveStatic(request, response);
  } catch (error) {
    if (response.headersSent || response.destroyed) return;
    const status = error.status || 500;
    if (status === 500) console.error("Error en el servidor:", error);
    sendJson(response, status, { error: status === 500 ? "Ocurrió un error interno. Intenta nuevamente." : error.message });
  }
});

initializeDataFiles().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`Nova Salud disponible en http://${HOST}:${PORT}`);
    if (configuredPassword === "NovaSalud2026!") {
      console.warn("Usando contraseña de demostración. Define BOTICA_PASSWORD antes de publicar.");
    }
  });
}).catch((error) => {
  console.error("No se pudieron inicializar los archivos de datos:", error);
  process.exitCode = 1;
});
