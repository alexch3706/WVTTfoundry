import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { MAGIC, magicInfo, magicItemData } from './magic-catalog.js';
import { IMPLEMENTED_MAGIC, magicVigor } from './magic-state.js';
import { castMagic } from './magic-ui.js';

/** Reuse the actual cast target/choice/native-area review. Only the authoritative
 * command, source permission and previewed cost differ for a required Ley event. */
export async function resolveLeyUI(actorUuid, jobId) {
  if (!game.user.isGM) throw new RuleError('The GM resolves the replacement/random target.');
  const [runtime, magicRuntime, regions, authority] = await Promise.all([
    import('./runtime.js'),
    import('./magic-runtime.js'),
    import('./magic-regions.js'),
    import('./authority.js'),
  ]);
  const actor = await runtime.actorFromUuid(actorUuid);
  let job = actor.system.magic.leyConnection?.pending?.find((row) => row.id === jobId);
  if (!job) throw new RuleError('This Ley consequence has already been resolved.');
  if (!job.magicChosen) {
    let magicKey = job.magicKey;
    if (job.type === 'replaceSpell') {
      const choices = MAGIC.filter(
        (row) =>
          row.kind === 'spell' &&
          row.element === 'air' &&
          row.tier === job.tier &&
          row.key !== job.magicKey &&
          IMPLEMENTED_MAGIC.has(row.key)
      );
      if (!choices.length)
        throw new RuleError(
          'No different implemented Air spell matches this level; the GM must resolve the book’s level ambiguity for this magic.'
        );
      const selected = await runtime.prompt(
        'Air Ley replacement',
        runtime.input('magicKey', 'Different Air spell of the same level', {
          options: Object.fromEntries(choices.map((row) => [row.key, row.name])),
        }),
        { button: 'Choose replacement' }
      );
      if (!selected) return;
      magicKey = selected.magicKey;
    }
    job = await authority.runCommand('magicLeyChoose', { actorUuid, jobId, magicKey });
  }
  const magic = magicInfo(job.replacementKey),
    virtual = { ...magicItemData(magic), id: `ley-${job.id}`, actor, isOwner: true };
  const api = {
    ...runtime,
    ...magicRuntime,
    ...regions,
    resolve: (uuid) => foundry.utils.fromUuid(uuid),
    learnedMagic: () => ({ item: virtual, magic }),
    actionPlan: () => ({
      changes: { 'system.sta.value': actor.system.sta.value - (job.type === 'repeatSpell' ? 3 : 0) },
      cost: job.type === 'repeatSpell' ? 3 : 0,
      modifier: job.type === 'repeatSpell' ? -3 : 0,
    }),
    magicSpending: (_actor, _magic, power, _values, plan) =>
      job.type === 'repeatSpell'
        ? magicRuntime.magicSpending(
            actor,
            magic,
            job.originalSTA,
            { maintenance: true, overdraw: true },
            plan
          )
        : {
            cost: {
              power,
              staCost: 0,
              roundBefore: actor.system.magic.spent || 0,
              roundAfter: actor.system.magic.spent || 0,
              vigor: magicVigor(actor.system, magic),
              staAfter: actor.system.sta.value,
              hpCost: 0,
            },
          },
    runCommand: (_name, payload) =>
      authority.runCommand('magicLeyResolve', { ...payload, actorUuid, jobId, version: job.version }),
  };
  return castMagic(actor, virtual, {
    services: api,
    tokenUuid: job.tokenUuid,
    leyJob: job,
    power: job.type === 'repeatSpell' ? job.power : magic.cost.min,
    ...(job.targetUuid ? { targetUuids: [job.targetUuid] } : {}),
  });
}
