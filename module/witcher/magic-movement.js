import { RuleError } from './rules.js';
import { magicMovementRules, magicRuleEntries } from './magic-effect-hooks.js';
import {
  magicTokenOrigin,
  magicSceneScale,
  previewMagicRegion,
  validateMagicRegion,
} from './magic-regions.js';
import { registerCommand, authorizedActor, runCommand } from './authority.js';
import { owner, prompt, input, chat, turnIdentity } from './runtime.js';

export function canGlide(state) {
  return magicRuleEntries(state).some(({ rule }) => rule?.key === 'glide');
}

export function glidePlan(token, descent, placement) {
  descent = Number(descent);
  if (!Number.isFinite(descent) || descent <= 0) throw new RuleError('Enter a positive descent in metres.');
  const state = token.actor.system;
  if (!canGlide(state)) throw new RuleError('No active spell permits gliding.');
  if (state.conditions.some((key) => ['dead', 'stunned', 'unconscious', 'pinned', 'grappled'].includes(key)))
    throw new RuleError('This condition prevents controlled gliding.');
  const movement = magicMovementRules(state, { action: 'move', verticalDescent: descent });
  if (movement.blocked) throw new RuleError(movement.reasons.join(' '));
  const origin = magicTokenOrigin(token),
    scale = magicSceneScale(token.parent);
  const horizontal = Math.hypot(placement.x - origin.x, placement.y - origin.y) / scale.pixelsPerMetre;
  if (!Number.isFinite(horizontal) || horizontal > movement.maximumGlideHorizontal + 0.001)
    throw new RuleError(`This descent permits at most ${movement.maximumGlideHorizontal}m horizontally.`);
  return {
    origin,
    horizontal,
    descent,
    destination: {
      x: placement.x,
      y: placement.y,
      elevation: origin.elevation - descent / scale.metresPerUnit,
    },
    changes: {
      x: token.x + placement.x - origin.x,
      y: token.y + placement.y - origin.y,
      elevation: token.elevation - descent / scale.metresPerUnit,
    },
  };
}

export async function glide(actor) {
  owner(actor);
  const tokens = [...(globalThis.canvas?.scene?.tokens ?? [])].filter(
    (token) => token.actor?.uuid === actor.uuid
  );
  if (!tokens.length) throw new RuleError('Place this actor on the viewed scene.');
  const answer = await prompt(
    'Glide',
    input('tokenId', 'Token', {
      options: Object.fromEntries(tokens.map((token) => [token.id, token.name])),
    }) +
      input('descent', 'Vertical descent (metres)', { value: 2, min: 0.01, step: 'any' }) +
      '<p>Adenydd permits 2m horizontally for each 2m descended. Landing while the spell is active prevents falling damage. Choose the destination on the map; elevation changes with the descent.</p>',
    { button: 'Place destination' }
  );
  if (!answer) return;
  const token = tokens.find((row) => row.id === answer.tokenId);
  if (!token) throw new RuleError('Select a token.');
  const descent = Number(answer.descent),
    origin = magicTokenOrigin(token);
  const plan = glidePlan(token, descent, origin);
  const spec = {
    shape: 'circle',
    radius: 0.25,
    range: magicMovementRules(actor.system, { verticalDescent: descent }).maximumGlideHorizontal,
    origin: 'ranged',
    wallRestriction: false,
  };
  const preview = await previewMagicRegion({ casterToken: token, spec, name: 'Glide destination' });
  if (!preview) return;
  return runCommand('magicGlide', {
    actorUuid: actor.uuid,
    tokenUuid: token.uuid,
    descent,
    placement: preview.placement,
    expectedOrigin: plan.origin,
    expectedTurn: turnIdentity(),
  });
}

export function registerMagicMovement() {
  registerCommand('magicGlide', async (payload, { user }) => {
    const actor = await authorizedActor(payload.actorUuid, user);
    const token = await foundry.utils.fromUuid(payload.tokenUuid);
    if (!token || token.actor?.uuid !== actor.uuid || token.parent?.id !== canvas.scene?.id)
      throw new RuleError('Choose this actor’s token on the viewed scene.');
    if (payload.expectedTurn !== turnIdentity()) throw new RuleError('The turn changed before movement.');
    if (game.combat?.started && game.combat.combatant?.actor?.uuid !== actor.uuid)
      throw new RuleError('Advance the tracker to this actor’s turn before gliding.');
    const plan = glidePlan(token, payload.descent, payload.placement);
    validateMagicRegion({
      scene: token.parent,
      casterToken: token,
      spec: {
        shape: 'circle',
        radius: 0.25,
        range: magicMovementRules(actor.system, { verticalDescent: plan.descent }).maximumGlideHorizontal,
        origin: 'ranged',
        wallRestriction: false,
      },
      placement: payload.placement,
      expectedOrigin: payload.expectedOrigin,
      requester: user,
    });
    if (typeof token.object?.checkCollision !== 'function')
      throw new RuleError('View this token’s scene to check the glide path.');
    if (token.object.checkCollision(plan.destination, { origin: plan.origin, type: 'move', mode: 'any' }))
      throw new RuleError('A wall blocks this glide path.');
    const before = { x: token.x, y: token.y, elevation: token.elevation };
    try {
      await token.update(plan.changes);
      return await chat(
        actor,
        'Glide',
        `<p>Descended ${plan.descent}m and moved ${Math.round(plan.horizontal * 100) / 100}m horizontally. No falling damage if landing while Adenydd remains active.</p>`
      );
    } catch (error) {
      await token.update(before, { witcherMagicRollback: true });
      throw error;
    }
  });
}
