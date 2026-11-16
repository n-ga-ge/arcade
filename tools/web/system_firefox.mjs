// Sanity run in the system's own Firefox (snap) through geckodriver.
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
const options = new firefox.Options().addArguments('-headless').setPreference('media.autoplay.default', 0);
const service = new firefox.ServiceBuilder('/snap/bin/geckodriver');
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const caps = await driver.getCapabilities();
  console.log('browser', caps.getBrowserName(), caps.getBrowserVersion());
  const t0 = Date.now();
  await driver.get('http://127.0.0.1:8080/?persist=0&fw=/local/NGAGE.ROM&game=/local/shadowkey.zip');
  let s = {};
  for (let i = 0; i < 300; i++) { s = await driver.executeScript("const p = window.eka2l1Page || {}; return { status: document.getElementById('status').textContent, running: !!p.app, frames: p.emu && p.emu.module ? p.emu.frames() : -1 };"); if (s.running && s.frames > 0) break; await sleep(200); }
  console.log('running after', Date.now() - t0, 'ms', JSON.stringify(s));
  const support = await driver.executeScript("const s = window.eka2l1Page.support; return { ok: s.ok, webgl: s.webgl.renderer, webgpu: s.webgpu.working ? s.webgpu.adapter : s.webgpu.error, missing: s.optional.filter(i => !i.ok).map(i => i.name) };");
  console.log('support', JSON.stringify(support));
  const a = await driver.executeScript('return window.eka2l1.frames()'); await sleep(10000); const b = await driver.executeScript('return window.eka2l1.frames()');
  console.log('intro fps over 10s', ((b - a) / 10).toFixed(1));
} finally { await driver.quit(); }
