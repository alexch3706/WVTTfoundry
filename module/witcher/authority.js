import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { actorFromUuid, serial, escapeHTML as e, errorNotice } from './runtime.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';

const commands = new Map();
const pending = new Map();
export const registerCommand = (name, handler) => commands.set(name, handler);
export async function authorizedActor(uuid, user) {
  const actor = await actorFromUuid(uuid);
  if (!actor || !actor.testUserPermission(user, 'OWNER')) throw new RuleError('You do not own this actor.');
  return actor;
}
function execute(name, payload, user, id) {
  const handler = commands.get(name);
  if (!handler) throw new RuleError('Unknown Witcher command.');
  return serial('witcher-authority', () => handler(foundry.utils.deepClone(payload), { user, id }));
}

/** All clients use the same elected GM for resource-changing combat commands.
 * Chat messages provide authenticated authors, persistence and reconnect recovery.
 */
export async function runCommand(name, payload, { label = name } = {}) {
  if (isPrimaryActiveGm()) return execute(name, payload, game.user, foundry.utils.randomID());
  const gm = game.users.activeGM ?? game.users.find((u) => u.active && u.isGM);
  if (!gm) throw new RuleError('An active GM is needed to resolve combat and inventory actions.');
  const id = foundry.utils.randomID();
  let timer;
  const result = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new RuleError(
          'The GM has not finished this action. Check the pending request in chat before retrying.'
        )
      );
    }, 45000);
    pending.set(id, { resolve, reject, timer });
  });
  // Attach immediately: a failed message create must not leave an unhandled promise.
  result.catch(() => {});
  try {
    await ChatMessage.create({
      author: game.user.id,
      whisper: [...new Set([game.user.id, ...game.users.filter((u) => u.active && u.isGM).map((u) => u.id)])],
      content: `<article class="witcher-chat"><p>${e(label)} — awaiting GM.</p><button type="button" data-witcher-command-retry>Process pending request (GM)</button></article>`,
      flags: { [SYSTEM_ID]: { kind: 'command', id, command: name, payload, status: 'pending' } },
    });
  } catch (error) {
    clearTimeout(timer);
    pending.delete(id);
    throw error;
  }
  return result;
}

async function processRequest(message) {
  if (!isPrimaryActiveGm()) return;
  const data = message.flags[SYSTEM_ID];
  if (data?.kind !== 'command' || data.status !== 'pending') return;
  await serial('witcher-requests', async () => {
    if (message.flags[SYSTEM_ID].status !== 'pending') return;
    const user = message.author;
    if (!user) throw new RuleError('The request author no longer exists.');
    // Persist ownership of the request before rolling or spending anything.
    await message.update({ [`flags.${SYSTEM_ID}.status`]: 'running' });
    let result;
    try {
      result = await execute(data.command, data.payload, user, data.id);
    } catch (error) {
      await message.update({
        [`flags.${SYSTEM_ID}.status`]: 'error',
        [`flags.${SYSTEM_ID}.error`]: error.message,
        content: `<article class="witcher-chat"><p>${e(data.command)}: ${e(error.message)}</p></article>`,
      });
    }
    if (message.flags[SYSTEM_ID].status === 'running') {
      // A receipt write can fail after the operation succeeded. Leave it running; never execute twice.
      await message.update({
        [`flags.${SYSTEM_ID}.status`]: 'done',
        [`flags.${SYSTEM_ID}.resultUuid`]: result?.uuid ?? '',
        content: `<article class="witcher-chat"><p>${e(data.command)} — completed.</p></article>`,
      });
    }
  });
}

export function registerAuthority() {
  Hooks.on('createChatMessage', (message) => processRequest(message).catch(errorNotice));
  Hooks.on('updateChatMessage', (message) => {
    const data = message.flags[SYSTEM_ID],
      task = pending.get(data?.id);
    if (!task || !['done', 'error'].includes(data.status)) return;
    clearTimeout(task.timer);
    pending.delete(data.id);
    if (data.status === 'done') task.resolve(data.resultUuid);
    else task.reject(new RuleError(data.error));
  });
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const button = html.querySelector('[data-witcher-command-retry]');
    if (!button) return;
    button.hidden = !isPrimaryActiveGm();
    button.addEventListener('click', () => processRequest(message).catch(errorNotice));
  });
  if (isPrimaryActiveGm())
    for (const message of game.messages) {
      const data = message.flags[SYSTEM_ID];
      if (data?.kind === 'command' && data.status === 'pending') processRequest(message).catch(errorNotice);
    }
}
