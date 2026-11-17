// แจ้งเตือนบนอุปกรณ์นี้ (Web Push): a switch put into every [data-push] element (inbox.html notify dialog, calendar.html
// bell dialog). Turning it on registers sw.js, asks the browser's permission and sends the subscription to
// /api/push/subscribe (push.mjs). Hidden for accounts without notices (external). Needs auth.js (window.api).
// iPhone/iPad deliver push only to the site added to the Home Screen (iOS 16.4+), so there it says how.
(function () {
  const slots = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-push]'));
  if (!slots.length) return;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = /** @type {any} */ (navigator).standalone === true || matchMedia('(display-mode: standalone)').matches;
  const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  let publicKey = null;

  const reg = () => navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready);
  const current = async () => (supported ? (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription() : null) || null;

  function build(slot, i) {
    slot.innerHTML = `
      <label class="flex cursor-pointer items-center gap-4 rounded-2xl bg-surface2/70 px-4 py-3">
        <span class="min-w-0 flex-1">
          <span class="block text-[15px]">แจ้งเตือนบนอุปกรณ์นี้ (มือถือ หรือคอมพิวเตอร์)</span>
          <span class="mt-0.5 block text-[13px] leading-[1.6] text-ink2" id="pushHint${i}"></span>
        </span>
        <span class="switch"><input type="checkbox" aria-describedby="pushHint${i}" aria-label="แจ้งเตือนบนอุปกรณ์นี้"><span class="track"></span><span class="knob"></span></span>
      </label>
      <div class="mt-2 flex justify-end" hidden>
        <button type="button" class="press t-quick h-11 rounded-2xl border border-line px-4 font-display text-[15px] font-medium hover:-translate-y-0.5">ส่งการแจ้งเตือนทดสอบ</button>
      </div>`;
    return { input: slot.querySelector('input'), hint: slot.querySelector(`#pushHint${i}`), testRow: slot.querySelector('div[hidden]'), test: slot.querySelector('button') };
  }
  const views = [...slots].map((s, i) => ({ slot: s, ...build(s, i) }));
  const say = (text) => views.forEach((v) => { v.hint.textContent = text; });

  async function paint() {
    const sub = await current().catch(() => null);
    const on = !!sub && Notification.permission === 'granted';
    let hint = 'งานที่ได้รับมอบหมาย เตือนก่อนวันงาน และคำขอใช้บริการ เด้งที่หน้าจอทันที';
    let disabled = false;
    if (!supported) {
      disabled = true;
      hint = ios && !standalone ? 'iPhone/iPad: กดปุ่มแชร์ เลือก “เพิ่มไปยังหน้าจอโฮม” แล้วเปิดเว็บจากไอคอนนั้น จึงจะเปิดได้' : 'เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน';
    } else if (Notification.permission === 'denied') {
      disabled = true;
      hint = 'เบราว์เซอร์ปิดการแจ้งเตือนของเว็บนี้ไว้ เปิดได้ที่การตั้งค่าเว็บไซต์ของเบราว์เซอร์';
    } else if (on) hint = 'เปิดอยู่ ' + hint;
    views.forEach((v) => { v.input.checked = on; v.input.disabled = disabled; v.testRow.hidden = !on; });
    say(hint);
  }

  async function turnOn() {
    if (await Notification.requestPermission() !== 'granted') return;
    const r = await reg();
    const sub = await r.pushManager.getSubscription() || await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  }
  async function turnOff() {
    const sub = await current();
    if (!sub) return;
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }

  views.forEach((v) => {
    v.input.addEventListener('change', async () => {
      views.forEach((w) => { w.input.disabled = true; });
      try { await (v.input.checked ? turnOn() : turnOff()); } catch (err) { say(err.message || 'เปิดการแจ้งเตือนไม่สำเร็จ'); await new Promise((r) => setTimeout(r, 2500)); }
      await paint();
    });
    v.test.addEventListener('click', async () => {
      v.test.disabled = true;
      try { const r = await api('/push/test', { method: 'POST', body: {} }); say(r.sent ? 'ส่งแล้ว รอสักครู่ การแจ้งเตือนจะเด้งขึ้น' : 'ส่งไม่สำเร็จ ลองปิดแล้วเปิดใหม่อีกครั้ง'); } catch (err) { say(err.message); }
      v.test.disabled = false;
    });
  });

  views.forEach((v) => { v.slot.hidden = true; });
  api('/push/key').then(async (k) => {
    publicKey = k.publicKey;
    views.forEach((v) => { v.slot.hidden = false; });
    // This browser stays on only if the server has it for this account: after logging out, or with another person
    // signed in, it is turned off here too, so nobody gets notices without turning the switch on themselves
    const sub = await current().catch(() => null);
    if (sub) {
      const r = await api('/push/check', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => null);
      if (r && !r.on) await sub.unsubscribe().catch(() => {});
    }
    await paint();
  }).catch(() => {});
})();
