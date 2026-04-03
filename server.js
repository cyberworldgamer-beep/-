const WebSocket = require('ws');

// ========== НАСТРОЙКИ ==========
const WIDTH = 800;
const HEIGHT = 600;
const TANK_SIZE = 40;          // размер танка (квадрат)
const BULLET_RADIUS = 5;
const TANK_SPEED = 3.5;        // пикселей за тик
const TURN_SPEED = 3;          // градусов за тик
const BULLET_SPEED = 8;
const COOLDOWN_TICKS = 15;     // перезарядка (0.5 сек при 30 тик/сек)
const RESPAWN_TICKS = 150;     // 5 секунд респавна
const TICKS_PER_SECOND = 30;
const TICK_INTERVAL_MS = 1000 / TICKS_PER_SECOND;

// Стена (один прямоугольник)
const WALL = { x: 350, y: 250, w: 100, h: 100 };

// Базовые позиции для появления танков
const BASES = [
    { x: 100, y: 100 },
    { x: 700, y: 100 },
    { x: 100, y: 500 },
    { x: 700, y: 500 }
];

// ========== ГЛОБАЛЬНОЕ СОСТОЯНИЕ ==========
let players = new Map();       // key: socket, value: player object
let tanks = new Map();         // key: tankId, value: tank object
let bullets = [];
let nextTankId = 1;

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
// Проверка пересечения двух прямоугольников (AABB)
function rectCollide(r1, r2) {
    return !(r2.x > r1.x + r1.w ||
        r2.x + r2.w < r1.x ||
        r2.y > r1.y + r1.h ||
        r2.y + r2.h < r1.y);
}

// Получить прямоугольник танка
function getTankRect(tank) {
    return {
        x: tank.x - TANK_SIZE/2,
        y: tank.y - TANK_SIZE/2,
        w: TANK_SIZE,
        h: TANK_SIZE
    };
}

// Проверка столкновения танка со стеной
function tankCollideWithWall(tank) {
    const tankRect = getTankRect(tank);
    const wallRect = { x: WALL.x, y: WALL.y, w: WALL.w, h: WALL.h };
    return rectCollide(tankRect, wallRect);
}

// Проверка столкновения танка с границами поля
function tankCollideWithBorder(tank) {
    const half = TANK_SIZE/2;
    return (tank.x - half < 0 || tank.x + half > WIDTH ||
            tank.y - half < 0 || tank.y + half > HEIGHT);
}

// Проверка столкновения двух танков
function tanksCollide(t1, t2) {
    if (t1.id === t2.id) return false;
    const r1 = getTankRect(t1);
    const r2 = getTankRect(t2);
    return rectCollide(r1, r2);
}

// Поиск свободной базы
function getFreeBase() {
    for (let base of BASES) {
        let occupied = false;
        for (let tank of tanks.values()) {
            const dx = tank.x - base.x;
            const dy = tank.y - base.y;
            const dist = Math.hypot(dx, dy);
            if (dist < TANK_SIZE) {
                occupied = true;
                break;
            }
        }
        if (!occupied) return { x: base.x, y: base.y };
    }
    return null;
}

// Создать нового танка для игрока
function createTank(player, x, y, name) {
    const tank = {
        id: nextTankId++,
        playerId: player.id,
        x: x,
        y: y,
        angle: 0,          // градусы
        health: 3,
        name: name,
        control: {
            forward: false,
            backward: false,
            left: false,
            right: false
        },
        shootRequest: false,
        lastShotTick: 0
    };
    tanks.set(tank.id, tank);
    player.tank = tank;
    player.respawnTimer = null;
    return tank;
}

// Уничтожить танк (но не удалять игрока)
function destroyTank(player) {
    if (player.tank) {
        tanks.delete(player.tank.id);
        player.tank = null;
        player.respawnTimer = RESPAWN_TICKS;
    }
}

// Респавн игрока
function respawnPlayer(player) {
    const basePos = getFreeBase();
    if (!basePos) return false; // нет свободной базы
    createTank(player, basePos.x, basePos.y, player.name);
    return true;
}

// Отправить состояние всем клиентам
function broadcastSnapshot() {
    const snapshot = {
        type: 'snapshot',
        timestamp: Date.now(),
        tanks: Array.from(tanks.values()).map(t => ({
            id: t.id,
            x: t.x,
            y: t.y,
            angle: t.angle,
            health: t.health,
            name: t.name
        })),
        bullets: bullets.map(b => ({ x: b.x, y: b.y }))
    };
    const msg = JSON.stringify(snapshot);
    for (let [socket, player] of players.entries()) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(msg);
        }
    }
}

// Обработка столкновений танков с миром (границы, стена, другие танки)
function resolveTankCollision(tank, oldX, oldY) {
    // Проверка границ и стены
    if (tankCollideWithBorder(tank) || tankCollideWithWall(tank)) {
        tank.x = oldX;
        tank.y = oldY;
        return;
    }
    // Проверка столкновений с другими танками
    for (let other of tanks.values()) {
        if (tanksCollide(tank, other)) {
            tank.x = oldX;
            tank.y = oldY;
            return;
        }
    }
}

// ========== ИГРОВОЙ ЦИКЛ ==========
let currentTick = 0;
function gameTick() {
    currentTick++;

    // 1. Движение и повороты танков
    for (let tank of tanks.values()) {
        const oldX = tank.x, oldY = tank.y;
        let dx = 0, dy = 0;

        // Поворот
        if (tank.control.left) tank.angle -= TURN_SPEED;
        if (tank.control.right) tank.angle += TURN_SPEED;

        // Движение
        const rad = tank.angle * Math.PI / 180;
        if (tank.control.forward) {
            dx += Math.cos(rad) * TANK_SPEED;
            dy += Math.sin(rad) * TANK_SPEED;
        }
        if (tank.control.backward) {
            dx -= Math.cos(rad) * TANK_SPEED;
            dy -= Math.sin(rad) * TANK_SPEED;
        }

        tank.x += dx;
        tank.y += dy;

        resolveTankCollision(tank, oldX, oldY);
    }

    // 2. Стрельба
    for (let tank of tanks.values()) {
        if (tank.shootRequest && (currentTick - tank.lastShotTick) >= COOLDOWN_TICKS) {
            const rad = tank.angle * Math.PI / 180;
            const offset = TANK_SIZE / 2 + 5;
            const bullet = {
                id: Math.random(),
                x: tank.x + Math.cos(rad) * offset,
                y: tank.y + Math.sin(rad) * offset,
                vx: Math.cos(rad) * BULLET_SPEED,
                vy: Math.sin(rad) * BULLET_SPEED,
                ownerId: tank.playerId
            };
            bullets.push(bullet);
            tank.shootRequest = false;
            tank.lastShotTick = currentTick;
        }
    }

    // 3. Обновление пуль и коллизии
    for (let i = bullets.length-1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;

        // Границы
        if (b.x - BULLET_RADIUS < 0 || b.x + BULLET_RADIUS > WIDTH ||
            b.y - BULLET_RADIUS < 0 || b.y + BULLET_RADIUS > HEIGHT) {
            bullets.splice(i,1);
            continue;
        }

        // Стена
        const bulletRect = { x: b.x - BULLET_RADIUS, y: b.y - BULLET_RADIUS, w: BULLET_RADIUS*2, h: BULLET_RADIUS*2 };
        const wallRect = { x: WALL.x, y: WALL.y, w: WALL.w, h: WALL.h };
        if (rectCollide(bulletRect, wallRect)) {
            bullets.splice(i,1);
            continue;
        }

        // Попадание в танки
        let hit = false;
        for (let tank of tanks.values()) {
            if (tank.playerId === b.ownerId) continue; // не попадаем в себя
            const tankRect = getTankRect(tank);
            if (rectCollide(bulletRect, tankRect)) {
                tank.health--;
                hit = true;
                if (tank.health <= 0) {
                    // Уничтожаем танк, игроку назначаем респавн
                    const player = players.get(tank.playerId);
                    if (player) destroyTank(player);
                }
                break;
            }
        }
        if (hit) {
            bullets.splice(i,1);
        }
    }

    // 4. Респавн игроков
    for (let [socket, player] of players.entries()) {
        if (!player.tank && player.respawnTimer !== null) {
            player.respawnTimer--;
            if (player.respawnTimer <= 0) {
                respawnPlayer(player);
            }
        }
    }

    // 5. Отправка состояния клиентам
    broadcastSnapshot();
}

// Запуск игрового цикла
setInterval(gameTick, TICK_INTERVAL_MS);

// ========== WEBSOCKET СЕРВЕР ==========
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket сервер запущен на порту ${PORT}`);
console.log('WebSocket сервер запущен на порту 8080');

wss.on('connection', (ws) => {
    const playerId = Symbol('player'); // уникальный идентификатор
    const player = {
        id: playerId,
        socket: ws,
        tank: null,
        respawnTimer: null,
        name: `Player${players.size + 1}`,
        lastPing: Date.now()
    };
    players.set(ws, player);

    // Попытка создать танк на свободной базе
    const basePos = getFreeBase();
    if (basePos) {
        createTank(player, basePos.x, basePos.y, player.name);
        ws.send(JSON.stringify({ type: 'init', playerId: playerId.toString(), tankId: player.tank.id }));
    } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Нет свободной базы' }));
        ws.close();
        players.delete(ws);
        return;
    }

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            player.lastPing = Date.now();

            if (msg.type === 'ping') {
                // ничего не делаем, просто обновляем lastPing
            }
            else if (msg.type === 'keydown') {
                if (player.tank) {
                    switch(msg.key) {
                        case 'ArrowUp': player.tank.control.forward = true; break;
                        case 'ArrowDown': player.tank.control.backward = true; break;
                        case 'ArrowLeft': player.tank.control.left = true; break;
                        case 'ArrowRight': player.tank.control.right = true; break;
                    }
                }
            }
            else if (msg.type === 'keyup') {
                if (player.tank) {
                    switch(msg.key) {
                        case 'ArrowUp': player.tank.control.forward = false; break;
                        case 'ArrowDown': player.tank.control.backward = false; break;
                        case 'ArrowLeft': player.tank.control.left = false; break;
                        case 'ArrowRight': player.tank.control.right = false; break;
                    }
                }
            }
            else if (msg.type === 'shoot') {
                if (player.tank) {
                    player.tank.shootRequest = true;
                }
            }
            else if (msg.type === 'join') {
                if (msg.name) player.name = msg.name;
                if (player.tank) player.tank.name = player.name;
            }
        } catch(e) { console.warn('Ошибка обработки сообщения', e); }
    });

    ws.on('close', () => {
        // Удаляем игрока
        if (player.tank) tanks.delete(player.tank.id);
        players.delete(ws);
    });
});

// Heartbeat: удаление игроков, не отвечающих 5 секунд
setInterval(() => {
    const now = Date.now();
    for (let [socket, player] of players.entries()) {
        if (now - player.lastPing > 5000) {
            console.log(`Игрок ${player.name} отключен по таймауту`);
            if (player.tank) tanks.delete(player.tank.id);
            socket.close();
            players.delete(socket);
        }
    }
}, 1000);
