// Copyright 2021-2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { isNil, sortBy } from 'lodash';
import PQueue from 'p-queue';

import * as log from './logging/log';
import { assert } from './util/assert';
import { sleep } from './util/sleep';
import { missingCaseError } from './util/missingCaseError';
import { isNormalNumber } from './util/isNormalNumber';
import { take } from './util/iterables';
import type { ConversationModel } from './models/conversations';
import type { StorageInterface } from './types/Storage.d';
import * as Errors from './types/errors';
import { getProfile } from './util/getProfile';
import { MINUTE, HOUR, DAY, MONTH } from './util/durations';

const STORAGE_KEY = 'lastAttemptedToRefreshProfilesAt';
const MAX_AGE_TO_BE_CONSIDERED_ACTIVE = MONTH;
const MAX_AGE_TO_BE_CONSIDERED_RECENTLY_REFRESHED = DAY;
const MAX_CONVERSATIONS_TO_REFRESH = 50;
const MIN_ELAPSED_DURATION_TO_REFRESH_AGAIN = 12 * HOUR;
const MIN_REFRESH_DELAY = MINUTE;

export class RoutineProfileRefresher {
  private interval: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: {
      getAllConversations: () => ReadonlyArray<ConversationModel>;
      getOurConversationId: () => string | undefined;
      storage: Pick<StorageInterface, 'get' | 'put'>;
    }
  ) {}

  public async start(): Promise<void> {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
    }

    const { storage, getAllConversations, getOurConversationId } = this.options;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const refreshInMs = timeUntilNextRefresh(storage);

      log.info(`routineProfileRefresh: waiting for ${refreshInMs}ms`);

      // eslint-disable-next-line no-await-in-loop
      await sleep(refreshInMs);

      const ourConversationId = getOurConversationId();
      if (!ourConversationId) {
        log.warn('routineProfileRefresh: missing our conversation id');

        // eslint-disable-next-line no-await-in-loop
        await sleep(MIN_REFRESH_DELAY);

        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        await routineProfileRefresh({
          allConversations: getAllConversations(),
          ourConversationId,
          storage,
        });
      } catch (error) {
        log.error('routineProfileRefresh: failure', Errors.toLogFormat(error));

        // eslint-disable-next-line no-await-in-loop
        await sleep(MIN_REFRESH_DELAY);
      }
    }
  }
}

export async function routineProfileRefresh({
  allConversations,
  ourConversationId,
  storage,

  // Only for tests
  getProfileFn = getProfile,
}: {
  allConversations: ReadonlyArray<ConversationModel>;
  ourConversationId: string;
  storage: Pick<StorageInterface, 'get' | 'put'>;
  getProfileFn?: typeof getProfile;
}): Promise<void> {
  log.info('routineProfileRefresh: starting');

  const refreshInMs = timeUntilNextRefresh(storage);
  if (refreshInMs > 0) {
    log.info('routineProfileRefresh: too soon to refresh. Doing nothing');
    return;
  }

  log.info('routineProfileRefresh: updating last refresh time');
  await storage.put(STORAGE_KEY, Date.now());

  const conversationsToRefresh = getConversationsToRefresh(
    allConversations,
    ourConversationId
  );

  log.info('routineProfileRefresh: starting to refresh conversations');

  let totalCount = 0;
  let successCount = 0;

  async function refreshConversation(
    conversation: ConversationModel
  ): Promise<void> {
    log.info(
      `routineProfileRefresh: refreshing profile for ${conversation.idForLogging()}`
    );

    totalCount += 1;
    try {
      await getProfileFn(conversation.get('uuid'), conversation.get('e164'));
      log.info(
        `routineProfileRefresh: refreshed profile for ${conversation.idForLogging()}`
      );
      successCount += 1;
    } catch (err) {
      log.error(
        `routineProfileRefresh: refreshed profile for ${conversation.idForLogging()}`,
        err?.stack || err
      );
    }
  }

  const refreshQueue = new PQueue({
    concurrency: 5,
    timeout: MINUTE * 30,
    throwOnTimeout: true,
  });
  for (const conversation of conversationsToRefresh) {
    refreshQueue.add(() => refreshConversation(conversation));
  }
  await refreshQueue.onIdle();

  log.info(
    `routineProfileRefresh: successfully refreshed ${successCount} out of ${totalCount} conversation(s)`
  );
}

function timeUntilNextRefresh(storage: Pick<StorageInterface, 'get'>): number {
  const storedValue = storage.get(STORAGE_KEY);

  if (isNil(storedValue)) {
    return 0;
  }

  if (isNormalNumber(storedValue)) {
    const planned = storedValue + MIN_ELAPSED_DURATION_TO_REFRESH_AGAIN;
    const now = Date.now();
    return Math.max(0, planned - now);
  }

  assert(
    false,
    `An invalid value was stored in ${STORAGE_KEY}; treating it as nil`
  );
  return 0;
}

function getConversationsToRefresh(
  conversations: ReadonlyArray<ConversationModel>,
  ourConversationId: string
): Iterable<ConversationModel> {
  const filteredConversations = getFilteredConversations(
    conversations,
    ourConversationId
  );
  return take(filteredConversations, MAX_CONVERSATIONS_TO_REFRESH);
}

function* getFilteredConversations(
  conversations: ReadonlyArray<ConversationModel>,
  ourConversationId: string
): Iterable<ConversationModel> {
  const sorted = sortBy(conversations, c => c.get('active_at'));

  const conversationIdsSeen = new Set<string>([ourConversationId]);

  for (const conversation of sorted) {
    const type = conversation.get('type');
    switch (type) {
      case 'private':
        if (
          conversation.hasProfileKeyCredentialExpired() &&
          (conversation.id === ourConversationId ||
            !conversationIdsSeen.has(conversation.id))
        ) {
          conversation.set({
            profileKeyCredential: null,
            profileKeyCredentialExpiration: null,
          });
          conversationIdsSeen.add(conversation.id);
          yield conversation;
          break;
        }

        if (
          !conversationIdsSeen.has(conversation.id) &&
          isConversationActive(conversation) &&
          !hasRefreshedProfileRecently(conversation)
        ) {
          conversationIdsSeen.add(conversation.id);
          yield conversation;
        }
        break;
      case 'group':
        for (const member of conversation.getMembers()) {
          if (
            !conversationIdsSeen.has(member.id) &&
            !hasRefreshedProfileRecently(member)
          ) {
            conversationIdsSeen.add(member.id);
            yield member;
          }
        }
        break;
      default:
        throw missingCaseError(type);
    }
  }
}

function isConversationActive(
  conversation: Readonly<ConversationModel>
): boolean {
  const activeAt = conversation.get('active_at');
  return (
    isNormalNumber(activeAt) &&
    activeAt + MAX_AGE_TO_BE_CONSIDERED_ACTIVE > Date.now()
  );
}

function hasRefreshedProfileRecently(
  conversation: Readonly<ConversationModel>
): boolean {
  const profileLastFetchedAt = conversation.get('profileLastFetchedAt');
  return (
    isNormalNumber(profileLastFetchedAt) &&
    profileLastFetchedAt + MAX_AGE_TO_BE_CONSIDERED_RECENTLY_REFRESHED >
      Date.now()
  );
}
