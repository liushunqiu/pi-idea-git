# PI-Desktop 宿主 API 实测事实（2026-09-12，读 app.asar 二进制得出）

## `pi.events.on` 不返回 unsubscribe 句柄 —— `pi.events.off` 才是配对

`/Applications/PI-Desktop.app/Contents/Resources/app.asar`
→ `out/main/plugin-host-process.js:266-276`：

```js
events: {
  on: (event, handler) => {
    if (typeof handler !== "function") return;   // 唯一的 return —— 成功路径返回 undefined
    const listeners = eventListeners.get(event) ?? new Set();
    listeners.add(handler);
    eventListeners.set(event, listeners);
  },
  off: (event, handler) => {
    eventListeners.get(event)?.delete(handler);
  }
}
```

**结论**：`on()` 成功时返回 `undefined`。任何"保存 `on()` 的返回值然后当作
unsubscribe 调用"的写法在本机是 **inert（空操作）**——看起来对，其实什么都没解绑。
要解绑必须自己留着 handler 引用，调 `pi.events.off(event, handler)`。

这也是我第一版修复（`workspaceListenerOff = typeof off === "function" ? off : null`）
踩的坑：那段代码永远不会执行到 `off()`，因为 `off` 恒为 `null`。
已改为优先用 `off(event, handler)`，同时保留句柄路径以兼容别的宿主形态。

## 热重载**不会**累积泄漏的 handler（推翻一个先前假设）

先前 `.memories/pi-desktop-cpu-diagnosis.md` 里写的
"若宿主不随 reload 丢弃旧 handler，每次 reload 累加一个" —— **该假设不成立**：

- `reloadDevPlugin` → `loadFromPath` 会先 `await this.unload(manifest.id)`
  （`out/main/index.js:24961`）
- `unload` 执行 `loaded.child.kill()`（`24978` / `25048-25063`）
- 下一次 load 是全新的 `utilityProcess.fork`，模块级状态全新
- `lifecycle.unload` 还会清空 `eventListeners`（`plugin-host-process.js:386-392`）

所以每次 reload 是**整个插件子进程重开**，旧 handler 随之消失。
日志里 210 次 `plugin.unload` / 193 次 `plugin.reload.success` 也印证了这点。

**这意味着**：那条"监听器跨 reload 累积"的 CPU 归因**不成立**。
解绑仍然值得做（幂等性、`onLoad` 被重复调用的场景），但**不再是** CPU 问题的候选解释。

## 教训

读二进制取证比推理可靠。本次两条关键事实（`on` 的返回值、reload 是否重开进程）
都是打开 `asar` 之后 5 分钟就能确认的，而纯读插件源码永远推不出来——
会在两种可能之间反复摇摆。**涉及宿主 API 契约的问题，直接读宿主实现。**

解包命令（`asar` 工具随 Electron 生态，`npx asar` 可用）：

```bash
npx --yes asar extract /Applications/PI-Desktop.app/Contents/Resources/app.asar /tmp/asar-out
# 之后 grep 目标 API，例如：
grep -n "events:" -A 14 /tmp/asar-out/out/main/plugin-host-process.js
```
