// A deterministic GPU failure at the addon boundary exercises xterm's real DOM renderer.
export class WebglAddon { constructor() { throw new Error('Isolated fixture: WebGL unavailable'); } }
