// 保留舊入口：等同 `viewer.mjs --demo`；要用 dynamic import，static import 會在改 argv 之前就執行 viewer
process.argv.splice(2, 0, '--demo');
await import(new URL('./viewer.mjs', import.meta.url));
