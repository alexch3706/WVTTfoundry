import assert from "node:assert/strict";

export async function runModifiersDialogTests() {
  const previousFormApplication = globalThis.FormApplication;
  const previousGame = globalThis.game;
  globalThis.FormApplication = globalThis.FormApplication || class FormApplication {};
  globalThis.game = {
    ...(globalThis.game || {}),
    system: { id: "cyberpunk2020-rilerena" },
    settings: { get: () => true }
  };

  try {
    const { ModifiersDialog } = await import("../../module/dialog/modifiers.js");

    assertModifierOptionsRemainImmutable(ModifiersDialog);
    await assertSubmitConfirmsExactlyOnce(ModifiersDialog);

    return { name: "modifiers-dialog" };
  } finally {
    globalThis.FormApplication = previousFormApplication;
    globalThis.game = previousGame;
  }
}

function assertModifierOptionsRemainImmutable(ModifiersDialog) {
  const suppliedGroups = [[{
    localKey: "Range",
    dataPath: "range",
    defaultValue: "RangeClose",
    choices: ["RangeClose"]
  }]];
  const context = {
    options: {
      modifierGroups: suppliedGroups,
      targetTokens: [],
      extraMod: true,
      weapon: {}
    }
  };

  const firstRender = ModifiersDialog.prototype.getData.call(context);
  const secondRender = ModifiersDialog.prototype.getData.call(context);

  assert.equal(suppliedGroups.length, 1, "rendering must not append groups to caller options");
  assert.equal(suppliedGroups[0][0].fieldPath, undefined, "rendering must not enrich caller-owned modifiers");
  assert.equal(firstRender.modifierGroups.length, 2, "first render contains one extra modifier group");
  assert.equal(secondRender.modifierGroups.length, 2, "re-render does not duplicate the extra modifier group");
  assert.equal(firstRender.defaultValues.range, "RangeClose", "defaults are preserved");
  assert.equal(firstRender.defaultValues.extraMod, 0, "extra modifier defaults to zero");
}

async function assertSubmitConfirmsExactlyOnce(ModifiersDialog) {
  const formData = { range: "RangeClose", extraMod: 2 };
  let confirmations = 0;
  let confirmedData;
  const context = {
    object: null,
    options: {
      onConfirm: async data => {
        confirmations += 1;
        confirmedData = data;
      }
    },
    submit: () => {
      throw new Error("_updateObject must not recursively call submit()");
    }
  };

  await ModifiersDialog.prototype._updateObject.call(context, {}, formData);

  assert.equal(confirmations, 1, "one form submit confirms one attack");
  assert.equal(context.object, formData, "submitted form data is retained on the dialog");
  assert.equal(confirmedData, formData, "confirmation receives submitted form data");
}
