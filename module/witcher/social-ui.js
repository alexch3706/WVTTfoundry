/** Verbal Combat dialogs and chat actions for players and the GM. */
import { SYSTEM_ID, SKILLS } from './config.js';
import { RuleError } from './rules.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';
import { runCommand } from './authority.js';
import { prompt, input, manualCheckInput, errorNotice, escapeHTML as e } from './runtime.js';
import { SOCIAL_ATTACKS, SOCIAL_DEFENSES, SOCIAL_TOOLS, SOCIAL_CONVENTIONS } from './social-rules.js';
export { socialActorDisplay } from './social-runtime.js';
const list = (collection) => collection?.contents ?? Array.from(collection?.values?.() ?? collection ?? []);
const service = (options) => ({ prompt, runCommand, ...options });
const stateOf = (message) => message.flags[SYSTEM_ID];
const labels = {
  resolveRounding: [
    'Resolve rounding',
    { final: 'Round the final result down', average: 'Round the average down before multiplying' },
  ],
  halfDamage: ['Persuade half-die', { exact: 'Keep halves', floor: 'Round down', ceil: 'Round up' }],
  tiedDefense: [
    'Tied defense',
    {
      blockOnly: 'Blocks; no return damage or exit',
      fullEffect: 'Full successful defense, including its result',
    },
  ],
  cumulativeTiming: [
    'Seduce / Appeal / Intimidate damage increase',
    {
      subsequentHits: 'Starts with subsequent successful hits',
      triggeringHit: 'Includes the triggering successful hit',
    },
  ],
  cumulativeScope: [
    'Cumulative vulnerability',
    { source: 'Specific attacker', target: 'Shared against this defender' },
  ],
  multiDamage: [
    'Multi-target attack damage die',
    { shared: 'One shared die', separate: 'Separate die per target' },
  ],
  groupResolution: [
    'Group exchange',
    { simultaneous: 'Resolve every declared response', ordered: 'Stop when the attacker loses' },
  ],
  disengage: [
    'Successful Disengage',
    { participant: 'This participant leaves', encounter: 'The whole argument ends' },
  ],
  timing: [
    'Turn timing',
    {
      verbalTurns: 'Recorded verbal turn order; no physical action costs',
      foundryCombat: 'Use current Foundry Combat action costs',
    },
  ],
  repeatedDefenses: [
    'Additional verbal defenses in Foundry Combat',
    { free: 'Free', stamina: 'Usual 1 STA after the first' },
  ],
  implyUse: [
    'Imply once per combat',
    { attempt: 'An attempt consumes the use', success: 'Only a success consumes the use' },
  ],
  studyExpiry: [
    'Study one-round expiry',
    {
      startNextTurn: 'Start of next own turn',
      endNextTurn: 'End of next own turn',
      roundEnd: 'End of this verbal round',
    },
  ],
  studyScope: ['Study benefit', { target: 'Against studied opponent', all: 'All verbal checks' }],
  bribeScope: [
    'Bribe empathetic bonus',
    { target: 'Against bribed opponent', all: 'All empathetic verbal rolls' },
  ],
  bribeIncrements: [
    'Bribe increments',
    { whole: 'Only complete 50-Crown increments', fractional: 'Fractional increments permitted' },
  ],
  repeatedBribes: [
    'Repeated successful offers',
    { replace: 'Replace the earlier offer', sum: 'Add their bonuses' },
  ],
  tortureSeverity: [
    'Wound-threshold torture modifier',
    { replace: 'Replace ±3 with ±10', stack: 'Add ±10 to ±3' },
  ],
  tortureThreshold: [
    'Torture wound threshold',
    { below: 'HP below threshold', atOrBelow: 'HP at or below threshold' },
  ],
  negativeRecognition: [
    'Recognizing negative Reputation',
    { signed: 'Use signed Reputation', absolute: 'Use its absolute value' },
  ],
  faceDownFrequency: [
    'Reputation Face-Down frequency',
    { oncePerOpponent: 'Once per opponent in this argument', repeat: 'Repeated attempts allowed' },
  ],
};
export function socialConventionFields(values = {}) {
  return (
    '<details><summary>Table rulings (editable defaults)</summary><p>Core pp.176–177 leave these details open. Starting the argument records these table interpretations.</p>' +
    Object.entries(SOCIAL_CONVENTIONS)
      .map(([key, choices]) =>
        input(key, labels[key][0], { value: values[key] ?? choices[0], options: labels[key][1] })
      )
      .join('') +
    '</details>'
  );
}
const partyOptions = (state) =>
  Object.fromEntries(state.participants.map((row) => [row.actorUuid, row.name]));
const rollFields = (actor) =>
  manualCheckInput() +
  input('modifier', 'Situational modifier (GM guidance: ±1 / ±3 / ±5)', { value: 0 }) +
  input('luck', 'Luck spent', { value: 0, min: 0, max: actor.system.luck.value });

export async function startSocialCombat(actor, options = {}) {
  if (!game.user.isGM)
    throw new RuleError('The GM starts Verbal Combat and records its goals and table conventions.');
  const api = service(options),
    actors = list(game.actors),
    targeted = new Set(list(game.user.targets).map((token) => token.actor?.uuid));
  const selection = await api.prompt(
    'Start Verbal Combat',
    '<p>Choose the actual participants. The order below becomes the agreed verbal turn order unless this argument uses Foundry Combat.</p>' +
      actors
        .map((entry) =>
          input(`actor_${entry.id}`, entry.name, {
            type: 'checkbox',
            checked: entry.uuid === actor.uuid || targeted.has(entry.uuid),
          })
        )
        .join(''),
    { button: 'Set goals' }
  );
  if (!selection) return null;
  const selected = [actor, ...actors.filter((row) => row.uuid !== actor.uuid)].filter(
    (entry) => selection[`actor_${entry.id}`]
  );
  if (selected.length < 2) throw new RuleError('Choose at least two actual participants.');
  const goals = await api.prompt(
    'Goals and audience',
    input('name', 'Argument name', { type: 'text', value: 'Argument' }) +
      input('public', 'Public argument', { type: 'checkbox' }) +
      input('audienceId', 'Audience name / group (shared by its Reputation effects)', { type: 'text' }) +
      selected
        .map(
          (entry, i) =>
            `<h3>${e(entry.name)}</h3>` +
            input(`side_${entry.id}`, 'Side', { type: 'text', value: i === 0 ? 'A' : 'B' }) +
            input(`goal_${entry.id}`, 'Exact goal / proposed agreement', { type: 'text' }) +
            input(`order_${entry.id}`, 'Verbal turn order', { value: i + 1, min: 1 }) +
            input(`rep_${entry.id}`, 'Relevant Reputation', {
              options: {
                general: 'Other reputation',
                'monster-slayer': 'Monster slayer (include trophy Reputation)',
              },
            }) +
            '<p>Skills for which this Reputation is relevant:</p>' +
            [...new Set(Object.values(SOCIAL_ATTACKS).map((move) => move.skill))]
              .map((skill) => input(`rep_skill_${entry.id}_${skill}`, SKILLS[skill][0], { type: 'checkbox' }))
              .join('')
        )
        .join('') +
      socialConventionFields(),
    { button: 'Start argument', width: 680 }
  );
  if (!goals) return null;
  const conventions = goals;
  selected.sort((a, b) => Number(goals[`order_${a.id}`]) - Number(goals[`order_${b.id}`]));
  return api.runCommand(
    'socialStart',
    {
      name: goals.name,
      public: !!goals.public,
      audienceId: goals.audienceId,
      conventionsConfirmed: true,
      conventions: Object.fromEntries(Object.keys(SOCIAL_CONVENTIONS).map((key) => [key, conventions[key]])),
      participants: selected.map((entry) => ({
        actorUuid: entry.uuid,
        side: goals[`side_${entry.id}`],
        goal: goals[`goal_${entry.id}`],
        reputationType: goals[`rep_${entry.id}`],
        reputationSkills: [...new Set(Object.values(SOCIAL_ATTACKS).map((move) => move.skill))].filter(
          (skill) => goals[`rep_skill_${entry.id}_${skill}`]
        ),
      })),
    },
    { label: 'Start Verbal Combat' }
  );
}
export async function declareSocialAction(message, options = {}) {
  const api = service(options),
    state = stateOf(message);
  const currentUuid =
    state.conventions.timing === 'foundryCombat'
      ? game.combat?.combatant?.actor?.uuid
      : state.order[state.turnIndex];
  const actor = await foundry.utils.fromUuid(currentUuid);
  if (!actor?.isOwner) throw new RuleError('The current participant’s owner chooses this action.');
  const opponents = state.participants.filter(
    (row) =>
      row.status === 'active' &&
      row.side !== state.participants.find((row) => row.actorUuid === actor.uuid).side
  );
  const answer = await api.prompt(
    'Verbal attack or tool',
    input('move', 'Move', {
      options: Object.fromEntries(
        Object.entries({ ...SOCIAL_ATTACKS, ...SOCIAL_TOOLS }).map(([key, value]) => [
          key,
          `${value.name}${SOCIAL_TOOLS[key] ? ' · full-turn tool' : ''}`,
        ])
      ),
    }) +
      opponents
        .map((row, i) => input(`target_${i}`, row.name, { type: 'checkbox', checked: i === 0 }))
        .join('') +
      input('skill', 'Imply skill', { options: { persuasion: 'Persuasion', deceit: 'Deceit' } }) +
      input('offer', 'Bribe offer in Crowns (not transferred until accepted)', { value: 0, min: 0 }) +
      rollFields(actor) +
      (state.conventions.timing === 'foundryCombat'
        ? input('extra', 'Extra action: 3 STA, −3 check', { type: 'checkbox' }) +
          input('forfeit', 'Forfeit remaining physical strikes', { type: 'checkbox' })
        : ''),
    { button: 'Declare' }
  );
  if (!answer) return null;
  if (['romance', 'imply', 'bribe'].includes(answer.move) && !state.toolOpposition[answer.move]) {
    if (!game.user.isGM)
      throw new RuleError(
        'This tool has no printed opposition. Ask the GM to record it in the argument’s tool ruling.'
      );
    const ruling = await api.prompt(
      `Opposition for ${SOCIAL_TOOLS[answer.move].name}`,
      toolOppositionFields(answer.move),
      { button: 'Record this ruling' }
    );
    if (!ruling) return null;
    await api.runCommand('socialRuling', {
      messageUuid: message.uuid,
      revision: stateOf(message).revision,
      kind: 'tool',
      values: { ...ruling, move: answer.move, dc: ruling.dc === '' ? null : Number(ruling.dc) },
    });
  }
  return api.runCommand(
    'socialDeclare',
    {
      messageUuid: message.uuid,
      revision: stateOf(message).revision,
      actorUuid: actor.uuid,
      move: answer.move,
      targetUuids: opponents.filter((_row, i) => answer[`target_${i}`]).map((row) => row.actorUuid),
      values: answer,
    },
    { label: 'Verbal action' }
  );
}
export async function defendSocialAction(message, actorUuid, options = {}) {
  const api = service(options),
    state = stateOf(message),
    actor = await foundry.utils.fromUuid(actorUuid);
  if (!actor?.isOwner) throw new RuleError('The defender’s owner chooses this response.');
  const exchange = state.pending,
    row = exchange?.targets.find((row) => row.actorUuid === actorUuid);
  if (!row || row.defense) throw new RuleError('This actor has no pending verbal defense.');
  const faceDown = exchange.kind === 'faceDown';
  const answer = await api.prompt(
    faceDown ? 'Reputation Face-Down' : 'Verbal defense',
    `<p>${e(exchange.move.name)} · opposing total ${row.check.total}</p>` +
      (faceDown
        ? input('manualDice', 'Ordinary d10 face, optional', { type: 'text' })
        : (exchange.move.tool
            ? `<p>GM-recorded opposition: ${e(SKILLS[exchange.opposition.skill]?.[0] ?? exchange.opposition.skill)}; ${e(exchange.opposition.reason)}</p>`
            : input('defense', 'Defense', {
                options: {
                  ...Object.fromEntries(
                    Object.entries(SOCIAL_DEFENSES).map(([key, value]) => [key, value.name])
                  ),
                  accept: 'Accept this argument / no defense',
                },
              }) +
              input('counterAttack', 'Counter-argument attack', {
                options: Object.fromEntries(
                  Object.entries(SOCIAL_ATTACKS).map(([key, value]) => [key, value.name])
                ),
              })) +
          rollFields(actor) +
          (actor.system.race === 'human'
            ? input('stubborn', 'If Resist Coercion fails, spend one Blindly Stubborn reroll (3/session)', {
                type: 'checkbox',
              }) + input('rerollDice', 'Optional manual dice for that reroll', { type: 'text' })
            : '')),
    { button: 'Resolve defense' }
  );
  if (!answer) return null;
  return api.runCommand(
    'socialDefense',
    {
      messageUuid: message.uuid,
      revision: state.revision,
      actorUuid,
      defense: answer.defense ?? 'ignore',
      counterAttack: answer.counterAttack,
      values: answer,
    },
    { label: 'Verbal defense' }
  );
}
function toolOppositionFields(move = 'romance') {
  return (
    '<p>Only Study supplies a printed DC. Record the actual adjudicated opposition for this tool.</p>' +
    input('move', 'Tool', { value: move, options: { romance: 'Romance', imply: 'Imply', bribe: 'Bribe' } }) +
    input('kind', 'Opposition', { options: { dc: 'Fixed DC', opposed: 'Actual opposed check' } }) +
    input('dc', 'DC (fixed option)', { value: '', min: 0 }) +
    input('skill', 'Opposing skill (opposed option)', {
      options: Object.fromEntries(Object.entries(SKILLS).map(([key, value]) => [key, value[0]])),
    }) +
    input('reason', 'Why this opposition applies', { type: 'text' })
  );
}
export function socialHistoryHTML(state) {
  return state.history
    .map(
      (entry) =>
        `<section><h4>${e(entry.summary ?? entry.kind)}</h4>${(entry.targets ?? []).map((row) => `<p>${e(state.participants.find((entry) => entry.actorUuid === row.actorUuid)?.name)}: attack ${row.check?.total ?? '—'} [${e(row.check?.dice?.join(', ') ?? '')}]${row.defense ? `; ${e(row.defense.move?.name)} ${row.defense.check.total} [${e(row.defense.check.dice?.join(', ') ?? '')}]` : ''}<br>${(row.modifiers ?? []).map((mod) => `${e(mod.label)} ${mod.value > 0 ? '+' : ''}${mod.value}`).join('; ')}</p>`).join('')}${(
          entry.results ?? []
        )
          .filter((row) => row.damage)
          .map(
            (row) =>
              `<p>Resolve ${row.before} → ${row.after}; damage die ${row.die}, cumulative bonus ${row.cumulative}.</p>`
          )
          .join('')}</section>`
    )
    .join('');
}
export async function openSocialEncounter(message, options = {}) {
  if (typeof message === 'string') message = await foundry.utils.fromUuid(message);
  const api = service(options),
    state = stateOf(message),
    gm = game.user.isGM;
  const actions = {
    view: 'View only',
    declare: 'Attack / tool',
    recognize: 'Recognize an opponent’s Reputation',
    faceDown: 'Reputation Face-Down',
  };
  if (gm)
    Object.assign(actions, {
      tool: 'Set missing tool opposition',
      context: 'Standing / communication / valid goal',
      torture: 'Record actual torture circumstances',
      endRomance: 'End a Romance',
      bribe: 'Accept and transfer a successful bribe',
      resetStubborn: 'Reset Blindly Stubborn for a new session',
      knownReputation: 'Record an already-known Reputation',
      end: 'End argument with a reason',
    });
  const answer = await api.prompt(
    state.name,
    `<p>${state.participants.map((row) => `${e(row.name)}: ${row.resolve}/${row.maxResolve} Resolve · ${e(row.goal)}`).join('<br>')}</p>` +
      socialHistoryHTML(state) +
      input('action', 'Action', { options: actions }) +
      input('actorUuid', 'Acting participant / observer / relationship holder', {
        options: partyOptions(state),
      }) +
      input('targetUuid', 'Other participant', { options: partyOptions(state) }),
    { button: 'Continue', width: 720 }
  );
  if (!answer || answer.action === 'view') return null;
  if (answer.action === 'declare') return declareSocialAction(message, options);
  const payload = {
    messageUuid: message.uuid,
    revision: state.revision,
    actorUuid: answer.actorUuid,
    targetUuid: answer.targetUuid,
  };
  if (['recognize', 'faceDown'].includes(answer.action)) {
    const value = await api.prompt(
      answer.action === 'recognize' ? 'Recognize Reputation' : 'Face-Down',
      '<p>Core p.60 uses one ordinary d10. A Face-Down requires the opponent to know your Reputation and grants +3 only to the GM-recorded relevant skills.</p>' +
        input('manualDice', 'Optional d10 face', { type: 'text' }),
      { button: 'Roll' }
    );
    if (!value) return null;
    return api.runCommand(answer.action === 'recognize' ? 'socialRecognition' : 'socialFaceDown', {
      ...payload,
      manualDice: value.manualDice,
      values: value,
    });
  }
  if (answer.action === 'bribe') {
    const offers = state.effects.filter((row) => row.kind === 'bribe' && !row.transferred);
    if (!offers.length) throw new RuleError('There is no successful unpaid bribe offer.');
    const value = await api.prompt(
      'Accept and transfer bribe',
      input('exchangeId', 'Offer', {
        options: Object.fromEntries(
          offers.map((row) => [
            row.exchangeId,
            `${partyOptions(state)[row.actorUuid]} → ${partyOptions(state)[row.recipientUuid]}: ${row.offer} Crowns`,
          ])
        ),
      }),
      { button: 'Transfer actual Crowns' }
    );
    return value ? api.runCommand('socialTransferBribe', { ...payload, exchangeId: value.exchangeId }) : null;
  }
  let fields = '';
  if (answer.action === 'tool') fields = toolOppositionFields();
  if (answer.action === 'context')
    fields =
      input('standing', 'Standing of acting participant toward this opponent', {
        options: { equal: 'Equal', tolerated: 'Tolerated', hated: 'Hated' },
      }) +
      input('feared', 'Also Feared', { type: 'checkbox' }) +
      input('intimacy', 'Intimate contact (relevant to Eternal Itch)', { type: 'checkbox' }) +
      input('communicationEvidence', 'Actual source allowing communication when otherwise impossible', {
        type: 'text',
      }) +
      input('animalGoalAllowed', 'An animal would do the stated goal for itself', { type: 'checkbox' }) +
      input('demonDealBeneficial', 'The stated bargain benefits this unbound demon', { type: 'checkbox' });
  if (answer.action === 'torture')
    fields =
      input('atMercy', 'Target is at the interrogator’s mercy', { type: 'checkbox' }) +
      input('evidence', 'Actual damage inflicted and circumstances', { type: 'text' }) +
      input('damageMessageUuid', 'Applied damage record, if available', {
        options: {
          '': 'Manual damage recorded above',
          ...Object.fromEntries(
            list(game.messages)
              .filter((row) => {
                const data = row.flags?.[SYSTEM_ID];
                return data?.kind === 'damage' && data.applied && data.targetUuid === answer.targetUuid;
              })
              .map((row) => [row.uuid, row.speaker?.alias || `Damage ${row.id}`])
          ),
        },
      });
  if (answer.action === 'endRomance')
    fields = input(
      'badly',
      'This Romance ended badly: permanent +3 against this romancer’s empathetic attacks',
      { type: 'checkbox' }
    );
  if (answer.action === 'resetStubborn')
    fields = '<p>Reset the selected human’s uses only when a new play session begins.</p>';
  if (answer.action === 'knownReputation')
    fields = input('reason', 'How the observer already knows this Reputation', { type: 'text' });
  if (answer.action === 'end') fields = input('reason', 'Why this argument ends', { type: 'text' });
  const values = await api.prompt('Record verbal-combat ruling', fields, { button: 'Record' });
  if (!values) return null;
  if (answer.action === 'tool') values.dc = values.dc === '' ? null : Number(values.dc);
  return api.runCommand('socialRuling', { ...payload, kind: answer.action, values });
}
export function registerSocialUI() {
  Hooks.on('updateCombat', () => {
    if (isPrimaryActiveGm()) runCommand('socialClock', {}).catch(errorNotice);
  });
  Hooks.on('renderChatMessageHTML', (message, html) => {
    if (stateOf(message)?.kind !== 'socialCombat') return;
    for (const button of html.querySelectorAll('[data-social-action]'))
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          if (button.dataset.socialAction === 'defend')
            await defendSocialAction(message, button.dataset.socialActor);
          else if (button.dataset.socialAction === 'declare') await declareSocialAction(message);
          else await openSocialEncounter(message);
        } catch (error) {
          errorNotice(error);
        } finally {
          button.disabled = false;
        }
      });
  });
}
