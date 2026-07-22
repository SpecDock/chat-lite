export type ConversationActivityStatus = 'streaming' | 'completed' | 'error';

export type ConversationActivity = {
  status: ConversationActivityStatus;
  unread: boolean;
};

export type ConversationActivities = Record<string, ConversationActivity>;

export function transitionConversationActivity(
  activities: ConversationActivities,
  conversationKey: string,
  status: ConversationActivityStatus,
  isOpen: boolean
): ConversationActivities {
  return {
    ...activities,
    [conversationKey]: { status, unread: status !== 'streaming' && !isOpen }
  };
}

export function clearConversationUnread(activities: ConversationActivities, conversationKey: string): ConversationActivities {
  const current = activities[conversationKey];
  if (!current || current.status === 'streaming' || !current.unread) return activities;
  return { ...activities, [conversationKey]: { ...current, unread: false } };
}

export function migrateConversationActivity(activities: ConversationActivities, fromKey: string, toKey: string): ConversationActivities {
  if (fromKey === toKey || !activities[fromKey]) return activities;
  const next = { ...activities, [toKey]: activities[fromKey] };
  delete next[fromKey];
  return next;
}

export function removeConversationActivity(activities: ConversationActivities, conversationKey: string): ConversationActivities {
  if (!activities[conversationKey]) return activities;
  const next = { ...activities };
  delete next[conversationKey];
  return next;
}

export function serializeUnreadActivities(activities: ConversationActivities): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(activities).filter(([, activity]) => activity.unread && activity.status !== 'streaming')
  ));
}

export function parseUnreadActivities(value: string | null): ConversationActivities {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, Partial<ConversationActivity>>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ConversationActivity] => {
      const activity = entry[1];
      return activity.unread === true && (activity.status === 'completed' || activity.status === 'error');
    }));
  } catch {
    return {};
  }
}
