global.Actor = class Actor {
  constructor() {}
  async _preCreate() {
    this._mockBasePreCreateCalls = (this._mockBasePreCreateCalls || 0) + 1;
    return this._mockPreCreateResult ?? true;
  }
  prepareData() {}
  updateSource() {}
  update() {}
  getRollData() { return this.system || {}; }
};
global.Item = class Item {
  constructor() {}
};
