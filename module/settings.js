export function registerSystemSettings() {
   /**
   * Track the system version upon which point a migration was last applied
   */
  game.settings.register(game.system.id, "systemMigrationVersion", {
    name: "SETTINGS.SysMigration",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  // Durable recovery journal for packs which were locked before a migration.
  // If a relock is interrupted, the next launch must restore that state before
  // the migration can be considered complete.
  game.settings.register(game.system.id, "migrationPendingPackRelocks", {
    name: "Pending migration pack relocks",
    scope: "world",
    config: false,
    type: String,
    default: "[]"
  });

  game.settings.register(game.system.id, "trainedSkillsFirst", {
    name: "SETTINGS.TrainedSkillsFirst",
    hint: "SETTINGS.TrainedSkillsFirstHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(game.system.id, "stagedPenetration", {
    name: "SETTINGS.StagedPenetration",
    hint: "SETTINGS.StagedPenetrationHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(game.system.id, "corebookFidelityMode", {
    name: "SETTINGS.CorebookFidelityMode",
    hint: "SETTINGS.CorebookFidelityModeHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(game.system.id, "combatDamageCommitMode", {
    name: "SETTINGS.CombatDamageCommitMode",
    hint: "SETTINGS.CombatDamageCommitModeHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      previewConfirm: "SETTINGS.CombatDamageCommitModePreviewConfirm",
      direct: "SETTINGS.CombatDamageCommitModeDirect"
    },
    default: "previewConfirm"
  });

  game.settings.register(game.system.id, "attackDieEntryMode", {
    name: "SETTINGS.AttackDieEntryMode",
    hint: "SETTINGS.AttackDieEntryModeHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      auto: "SETTINGS.AttackDieEntryModeAuto",
      prompt: "SETTINGS.AttackDieEntryModePrompt"
    },
    default: "auto"
  });

  // ── Visual Effects Settings ──────────────────
  game.settings.register(game.system.id, "enableScanlines", {
    name: "SETTINGS.EnableScanlines",
    hint: "SETTINGS.EnableScanlinesHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: (value) => {
      document.body.classList.toggle("fx-scanlines", value);
    }
  });

  game.settings.register(game.system.id, "enableGlow", {
    name: "SETTINGS.EnableGlow",
    hint: "SETTINGS.EnableGlowHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: (value) => {
      document.body.classList.toggle("fx-glow", value);
    }
  });
}

/**
 * Apply visual effect classes to document.body based on current settings.
 * Call this once during system init/ready.
 */
export function applyVisualEffectSettings() {
  if (game.settings.get(game.system.id, "enableScanlines")) {
    document.body.classList.add("fx-scanlines");
  }
  if (game.settings.get(game.system.id, "enableGlow")) {
    document.body.classList.add("fx-glow");
  }
}
