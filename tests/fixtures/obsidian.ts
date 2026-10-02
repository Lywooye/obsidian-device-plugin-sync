// Minimal DOM/Obsidian test double. This is not the real Obsidian UI or Sync runtime.
export const language = { value: 'zh' };
export const getLanguage = () => language.value;
export const apiVersion = '1.13.7';
export const Platform = { isMobile: false };
export const notices: string[] = [];
export const modals: Modal[] = [];
export class TFile { constructor(public path: string) {} }
export class TFolder { constructor(public path: string) {} }
export class Notice { constructor(text: string, _duration?: number) { notices.push(text); } }
export const timers = { next: 0, timeouts: new Map<number, () => void>(), intervals: new Map<number, () => void>() };
export const mockWindow = {
  setTimeout(callback: () => void, _delay: number) { const id = ++timers.next; timers.timeouts.set(id, callback); return id; },
  clearTimeout(id?: number) { if (id !== undefined) timers.timeouts.delete(id); },
  setInterval(callback: () => void, _delay: number) { const id = ++timers.next; timers.intervals.set(id, callback); return id; },
  clearInterval(id?: number) { if (id !== undefined) timers.intervals.delete(id); },
};
export class Plugin {
  constructor(public app: any) {}
  disposers: (() => void)[] = [];
  addSettingTab(_tab: unknown) {}
  register(callback: () => void) { this.disposers.push(callback); }
  registerInterval(id: number) { this.register(() => mockWindow.clearInterval(id)); }
  registerEvent(event: { dispose?: () => void }) { this.register(() => event.dispose?.()); }
  unload() { for (const callback of this.disposers.splice(0)) callback(); }
}
export class PluginSettingTab {
  containerEl = document.body.appendChild(document.createElement('section'));
  constructor(public app: any, public plugin: unknown) {}
}
export class Modal {
  modalEl = document.createElement('aside');
  titleEl = this.modalEl.appendChild(document.createElement('h2'));
  contentEl = this.modalEl.appendChild(document.createElement('div'));
  constructor(public app: any) {}
  onOpen() {}
  onClose() {}
  open() { modals.push(this); document.body.appendChild(this.modalEl); this.onOpen(); }
  close() { this.onClose(); this.modalEl.remove(); modals.splice(modals.indexOf(this), 1); }
}
function control(el: HTMLInputElement | HTMLSelectElement | HTMLButtonElement): any {
  const c: any = {
    setButtonText: (v: string) => { el.textContent = v; return c; },
    setValue: (v: string | boolean) => { if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v; else el.value = String(v); return c; },
    setPlaceholder: (v: string) => { el.setAttribute('placeholder', v); return c; },
    setDisabled: (v: boolean) => { el.disabled = v; return c; },
    setCta: () => c,
    onClick: (fn: () => void) => { el.addEventListener('click', fn); return c; },
    onChange: (fn: (v: any) => void) => { el.addEventListener('change', () => fn(el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value)); return c; },
    addOption: (value: string, text: string) => { const option = document.createElement('option'); option.value = value; option.textContent = text; el.appendChild(option); return c; },
    addOptions: (options: Record<string, string>) => { for (const [v, text] of Object.entries(options)) c.addOption(v, text); return c; },
  };
  return c;
}
export class Setting {
  el: HTMLDivElement;
  constructor(parent: HTMLElement) { this.el = parent.appendChild(document.createElement('div')); this.el.className = 'mock-setting'; }
  setName(name: string) { this.el.dataset.name = name; const label = this.el.appendChild(document.createElement('span')); label.textContent = name; return this; }
  setDesc(text: string) { this.el.appendChild(document.createElement('small')).textContent = text; return this; }
  addButton(fn: (c: any) => void) { fn(control(this.el.appendChild(document.createElement('button')))); return this; }
  addText(fn: (c: any) => void) { fn(control(this.el.appendChild(document.createElement('input')))); return this; }
  addDropdown(fn: (c: any) => void) { fn(control(this.el.appendChild(document.createElement('select')))); return this; }
  addToggle(fn: (c: any) => void) { const el = this.el.appendChild(document.createElement('input')); el.type = 'checkbox'; fn(control(el)); return this; }
}
export function installDomExtensions(window: any) {
  const proto = window.HTMLElement.prototype;
  proto.empty = function () { this.replaceChildren(); };
  proto.addClass = function (...names: string[]) { this.classList.add(...names); };
  proto.setText = function (text: string) { this.textContent = text; };
  proto.createEl = function (tag: string, options: any = {}) {
    const el = window.document.createElement(tag);
    if (options.text) el.textContent = options.text;
    if (options.cls) el.className = options.cls;
    if (options.type) el.type = options.type;
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
    this.appendChild(el); return el;
  };
  proto.createDiv = function (options: any) { return this.createEl('div', options); };
}
