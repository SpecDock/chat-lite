import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { AttachmentDTO, ConversationDTO, MessageDTO, SearchMessageResultDTO, UserDTO, WorkspaceFilesDTO } from '../../../shared/types';
import { api, streamChat, type ChatStreamData } from '../../shared/api/client';
import ConversationList from './ConversationList';
import ConversationSearch from './ConversationSearch';
import DeleteConversationDialog from './DeleteConversationDialog';
import DeleteMessageDialog from './DeleteMessageDialog';
import MessageInput from './MessageInput';
import MessageList from './MessageList';
import RenameConversationDialog from './RenameConversationDialog';
import {
  clearConversationUnread,
  migrateConversationActivity,
  parseUnreadActivities,
  removeConversationActivity,
  serializeUnreadActivities,
  transitionConversationActivity,
  type ConversationActivities
} from './conversationActivity';
import { composeUserMessage, splitUserMessage } from './messageContent';
import {
  drainConversationDelta,
  enqueueConversationDelta,
  normalizeStreamingMarkdownInterval,
  type ConversationDeltaBufferState,
  type DeltaFlushScheduler,
} from './conversationDeltaBuffer';
import ProfileMenu from '../profile/ProfileMenu';
import WorkspaceDialog from './WorkspaceDialog';
import ImageLightbox from '../messages/ImageLightbox';
import ImageStudioPage from '../studio/ImageStudioPage';
import { encodeExecutionBlock } from '../../../shared/execution-block';

const EMPTY_CONVERSATION_KEY = '__none__';
const TEMPORARY_CONVERSATION_PREFIX = '__temporary__:';
const DRAWER_BREAKPOINT = 799;
const DRAWER_ACTIVATION_DISTANCE = 8;
const DRAWER_OPEN_THRESHOLD = 0.20;
const DRAWER_CLOSE_THRESHOLD = 0.80;
const DRAWER_INERTIA_WINDOW_MS = 160;
const DRAWER_INERTIA_MAX_DISTANCE = 200;
const DRAWER_INERTIA_MAX_SPEED = 1.1;
const DRAWER_INERTIA_SAMPLE_MAX_AGE_MS = 100;
const DRAWER_FLING_SPEED_THRESHOLD = 0.05;
const DRAWER_FLING_MIN_DISTANCE = 2;
const DRAWER_SETTLE_MIN_DURATION = 0.18;
const DRAWER_SETTLE_MAX_DURATION = 0.42;
const DRAWER_FAST_SETTLE_MIN_DURATION = 0.14;
const DRAWER_FAST_SETTLE_MAX_DURATION = 0.26;
const DRAWER_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, option, label, summary, [role="button"], [role="link"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="combobox"], [role="textbox"], [aria-haspopup="menu"], [tabindex]:not([tabindex="-1"]), [data-drawer-interactive]';
const HORIZONTAL_SCROLL_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
const CODE_BLOCK_WHITE_SPACE = new Set(['pre', 'pre-wrap', 'break-spaces']);

type DrawerGestureDirection = 'open' | 'close';
type DrawerGesturePhase = 'candidate' | 'dragging';
type DrawerPhase = 'idle' | 'candidate' | 'dragging' | 'settling';

type DrawerPointerSample = {
  clientX: number;
  clientY: number;
  time: number;
};

type DrawerGesture = {
  direction: DrawerGestureDirection;
  pointerId: number;
  pointerDownTarget: Element | null;
  startX: number;
  startY: number;
  startOffset: number;
  width: number;
  phase: DrawerGesturePhase;
  captureTarget: HTMLElement | null;
  captureFailed: boolean;
  panelTransition: string;
  backdropTransition: string;
  previousSampleX: number | null;
  previousSampleTime: number | null;
  lastSampleX: number | null;
  lastSampleTime: number | null;
  startSampleTime: number | null;
  pendingSample: DrawerPointerSample | null;
  rafId: number | null;
  panelWillChange: string;
  backdropWillChange: string;
};

type DrawerMotion = {
  initialized: boolean;
  x: number;
  progress: number;
};

type DrawerReleasePrediction = {
  progress: number;
  directionalVelocity: number;
  isFling: boolean;
};

type DrawerSettle = {
  token: number;
  targetOpen: boolean;
  targetX: number;
  targetProgress: number;
  duration: number;
  frameId: number | null;
  timerId: number | null;
};

type DrawerClickSuppression = {
  target: Element;
  expiresAt: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clearDrawerMotionSamples(gesture: DrawerGesture) {
  gesture.previousSampleX = null;
  gesture.previousSampleTime = null;
  gesture.lastSampleX = null;
  gesture.lastSampleTime = null;
  gesture.startSampleTime = null;
}

function recordDrawerMotionSample(gesture: DrawerGesture, x: number, time: number) {
  if (gesture.phase !== 'dragging' || !Number.isFinite(x) || !Number.isFinite(time)) return;
  if (gesture.lastSampleX === null || gesture.lastSampleTime === null) {
    gesture.previousSampleX = gesture.startX;
    gesture.previousSampleTime = gesture.startSampleTime;
  } else {
    gesture.previousSampleX = gesture.lastSampleX;
    gesture.previousSampleTime = gesture.lastSampleTime;
  }
  gesture.lastSampleX = x;
  gesture.lastSampleTime = time;
}

function projectedDrawerProgress(gesture: DrawerGesture, progress: number, width: number, reduce: boolean): DrawerReleasePrediction {
  const noPrediction = { progress, directionalVelocity: 0, isFling: false };
  if (
    reduce
    || gesture.previousSampleX === null
    || gesture.previousSampleTime === null
    || gesture.lastSampleX === null
    || gesture.lastSampleTime === null
    || !Number.isFinite(width)
    || width <= 0
  ) return noPrediction;

  const elapsed = gesture.lastSampleTime - gesture.previousSampleTime;
  const sampleAge = performance.now() - gesture.lastSampleTime;
  if (
    !Number.isFinite(elapsed)
    || !Number.isFinite(sampleAge)
    || elapsed <= 0
    || sampleAge < 0
    || sampleAge > DRAWER_INERTIA_SAMPLE_MAX_AGE_MS
  ) return noPrediction;

  const velocity = (gesture.lastSampleX - gesture.previousSampleX) / elapsed;
  if (!Number.isFinite(velocity)) return noPrediction;
  const directionalVelocity = gesture.direction === 'open' ? velocity : -velocity;
  if (directionalVelocity <= 0) return noPrediction;
  const directionalDistance = gesture.direction === 'open'
    ? gesture.lastSampleX - gesture.startX
    : gesture.startX - gesture.lastSampleX;
  if (directionalVelocity >= DRAWER_FLING_SPEED_THRESHOLD && directionalDistance >= DRAWER_FLING_MIN_DISTANCE) {
    return { progress: gesture.direction === 'open' ? 1 : 0, directionalVelocity, isFling: true };
  }

  const projectionWindow = clamp(
    DRAWER_INERTIA_WINDOW_MS - sampleAge,
    0,
    DRAWER_INERTIA_WINDOW_MS,
  );
  if (!projectionWindow) return { progress, directionalVelocity, isFling: false };
  const projectedDistance = clamp(
    clamp(directionalVelocity, 0, DRAWER_INERTIA_MAX_SPEED) * projectionWindow,
    0,
    DRAWER_INERTIA_MAX_DISTANCE,
  );
  const projectedDelta = projectedDistance / width;
  return {
    progress: gesture.direction === 'open'
      ? clamp(progress + projectedDelta, 0, 1)
      : clamp(progress - projectedDelta, 0, 1),
    directionalVelocity,
    isFling: false,
  };
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function registerMediaQueryChangeListener(query: MediaQueryList, listener: () => void) {
  let registration: 'eventListener' | 'listener' | null = null;

  try {
    if (
      typeof query.addEventListener === 'function'
      && typeof query.removeEventListener === 'function'
    ) {
      query.addEventListener('change', listener);
      registration = 'eventListener';
    }
  } catch { /* fall through to the legacy listener API */ }

  if (!registration) {
    try {
      if (typeof query.addListener === 'function' && typeof query.removeListener === 'function') {
        query.addListener(listener);
        registration = 'listener';
      }
    } catch { /* older WebViews may expose an incomplete listener API */ }
  }

  return () => {
    try {
      if (registration === 'eventListener' && typeof query.removeEventListener === 'function') {
        query.removeEventListener('change', listener);
      } else if (registration === 'listener' && typeof query.removeListener === 'function') {
        query.removeListener(listener);
      }
    } catch { /* cleanup must remain safe in legacy WebViews */ }
  };
}

function registerVisualViewportResizeListener(visualViewport: VisualViewport | null, listener: () => void) {
  if (!visualViewport) return () => undefined;

  try {
    if (
      typeof visualViewport.addEventListener === 'function'
      && typeof visualViewport.removeEventListener === 'function'
    ) {
      visualViewport.addEventListener('resize', listener);
      return () => {
        try {
          visualViewport.removeEventListener('resize', listener);
        } catch { /* cleanup must remain safe in legacy WebViews */ }
      };
    }
  } catch { /* fall through to the recoverable onresize fallback */ }

  const previousOnResize = visualViewport.onresize;
  const fallbackOnResize = (event: Event) => {
    try {
      previousOnResize?.call(visualViewport, event);
    } finally {
      listener();
    }
  };
  try {
    visualViewport.onresize = fallbackOnResize;
    if (visualViewport.onresize !== fallbackOnResize) return () => undefined;
  } catch {
    return () => undefined;
  }

  return () => {
    try {
      if (visualViewport.onresize === fallbackOnResize) visualViewport.onresize = previousOnResize;
    } catch { /* cleanup must remain safe in legacy WebViews */ }
  };
}

function readVisualTransformX(element: Element, fallback: number) {
  const transform = window.getComputedStyle(element).transform;
  if (!transform || transform === 'none') return fallback;
  const values = transform.slice(transform.indexOf('(') + 1, -1).split(',').map(Number);
  const xIndex = values.length === 16 ? 12 : values.length === 6 ? 4 : -1;
  return xIndex >= 0 && Number.isFinite(values[xIndex]) ? values[xIndex] : fallback;
}

function readVisualOpacity(element: Element, fallback: number) {
  const parsed = Number.parseFloat(window.getComputedStyle(element).opacity);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePointerEventTimeStamp(timestamp: number, now: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return now;
  const epochNow = Date.now();
  const timeOrigin = Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : epochNow - now;
  const candidates = [timestamp, timestamp - timeOrigin, timestamp - (epochNow - now)]
    .filter(candidate => Number.isFinite(candidate) && candidate >= 0);
  let closest = now;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - now);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closestDistance <= 10_000 ? closest : now;
}

function readLatestDrawerPointerSample(event: ReactPointerEvent<HTMLDivElement>): DrawerPointerSample {
  const nativeEvent = event.nativeEvent;
  const now = performance.now();
  let latest: PointerEvent = nativeEvent;
  try {
    if (typeof nativeEvent.getCoalescedEvents === 'function') {
      const coalesced = nativeEvent.getCoalescedEvents();
      if (coalesced.length) latest = coalesced[coalesced.length - 1];
    }
  } catch { /* older WebViews may expose an incomplete PointerEvent */ }
  return {
    clientX: latest.clientX,
    clientY: latest.clientY,
    time: normalizePointerEventTimeStamp(latest.timeStamp, now),
  };
}

function isDrawerInteractiveTarget(element: Element | null) {
  if (!element) return false;
  if (element.closest(DRAWER_INTERACTIVE_SELECTOR)) return true;
  const editable = element.closest('[contenteditable]');
  return Boolean(editable && editable.getAttribute('contenteditable') !== 'false');
}

function isTopbarTarget(element: Element | null) {
  return Boolean(element?.closest('.topbar'));
}

function isComposerTarget(element: Element | null) {
  return Boolean(element?.closest('.composer'));
}

function drawerInteractiveControl(element: Element | null) {
  if (!element) return null;
  const editable = element.closest('[contenteditable]');
  if (editable && editable.getAttribute('contenteditable') !== 'false') return editable;
  return element.closest(DRAWER_INTERACTIVE_SELECTOR);
}

function isSameDrawerClickTarget(target: Element | null, original: Element | null) {
  if (!target || !original) return false;
  if (target === original) return true;
  const targetControl = drawerInteractiveControl(target);
  const originalControl = drawerInteractiveControl(original);
  return Boolean(targetControl && originalControl && targetControl === originalControl);
}

function hasRealHorizontalScroll(element: Element, style: CSSStyleDeclaration) {
  if (!HORIZONTAL_SCROLL_OVERFLOW.has(style.overflowX) || !(element instanceof HTMLElement)) return false;
  return element.scrollWidth > element.clientWidth + 1;
}

function isCodeBlockElement(element: Element, style: CSSStyleDeclaration) {
  const tagName = element.tagName.toLowerCase();
  const isCodeBlock = tagName === 'pre'
    || tagName === 'table'
    || (tagName === 'code' && (style.display === 'block' || CODE_BLOCK_WHITE_SPACE.has(style.whiteSpace)))
    || element.firstElementChild?.tagName.toLowerCase() === 'pre';
  return isCodeBlock && hasRealHorizontalScroll(element, style);
}

function isPointerCaptureElement(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement
    && typeof target.setPointerCapture === 'function'
    && typeof target.releasePointerCapture === 'function';
}

function isHorizontalScrollTarget(target: Element | null) {
  let element = target;
  while (element) {
    if (element.matches('.messages, .conv-list')) {
      element = element.parentElement;
      continue;
    }
    const style = window.getComputedStyle(element);
    if (isCodeBlockElement(element, style) || hasRealHorizontalScroll(element, style)) return true;
    element = element.parentElement;
  }
  return false;
}

function isChatContentTarget(element: Element | null) {
  return Boolean(element?.closest('main.chat'));
}

function isOpenGestureExcluded(element: Element | null) {
  return isTopbarTarget(element)
    || isComposerTarget(element)
    || isDrawerInteractiveTarget(element)
    || isHorizontalScrollTarget(element);
}

function isCloseGestureExcluded(element: Element | null) {
  return isTopbarTarget(element) || isHorizontalScrollTarget(element);
}

function safeGetItem(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function safeSetItem(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* ignore unavailable storage */ }
}

function safeRemoveItem(key: string) {
  try { window.localStorage.removeItem(key); } catch { /* ignore unavailable storage */ }
}

function parseEventData(event: MessageEvent) {
  try {
    return JSON.parse(event.data || '{}') as { conversationId?: string; reason?: string };
  } catch {
    return {};
  }
}

function replacePair(messages: MessageDTO[], userIndex: number, user: MessageDTO, assistant: MessageDTO) {
  const hasAssistant = messages[userIndex + 1]?.role === 'assistant';
  return [
    ...messages.slice(0, userIndex),
    user,
    assistant,
    ...messages.slice(userIndex + (hasAssistant ? 2 : 1))
  ];
}

function isTemporaryKey(key?: string) {
  return Boolean(key?.startsWith(TEMPORARY_CONVERSATION_PREFIX));
}

function conversationIdForKey(key?: string) {
  return key && key !== EMPTY_CONVERSATION_KEY && !isTemporaryKey(key) ? key : undefined;
}

function moveRecordValue<T>(record: Record<string, T>, fromKey: string, toKey: string): Record<string, T> {
  if (fromKey === toKey || !(fromKey in record)) return record;
  const next = { ...record, [toKey]: record[fromKey] };
  delete next[fromKey];
  return next;
}

function removeRecordValue<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

type ScrollIntent = 'restore' | 'bottom' | 'follow';
type EditMode = 'replace' | 'append';
type Operation = 'send' | 'edit';

type ActiveTask = ConversationDeltaBufferState & {
  controller: AbortController;
  assistantId: string;
  sentText: string;
  operation: Operation;
  cancelRequested: boolean;
};

const viteEnv = (import.meta as ImportMeta & { readonly env: Record<string, string | undefined> }).env;
const streamingMarkdownInterval = normalizeStreamingMarkdownInterval(viteEnv.VITE_STREAM_MARKDOWN_INTERVAL_MS);
const deltaFlushScheduler: DeltaFlushScheduler = {
  schedule: callback => window.setTimeout(callback, streamingMarkdownInterval),
  cancel: handle => window.clearTimeout(handle),
};

type Refill = { text: string; key: number };
type JumpTarget = { conversationId: string; messageId: string };
type ConversationDialogTarget = { conversation: ConversationDTO; trigger: HTMLButtonElement };

type StreamOptions = {
  conversationId?: string;
  text: string;
  attachmentIds: string[];
  editUserMessageId?: string;
  tempAssistantId: string;
  task: ActiveTask;
  getTargetKey: () => string;
  alignMeta: (data: ChatStreamData, assistantMessageId: string) => void;
};

export default function ChatPage({ user, initialScroll, onLogout }: { user: UserDTO; initialScroll: 'restore' | 'bottom'; onLogout: () => void }) {
  const storageKey = `chat-lite:last-conversation:${user.id}`;
  const activityStorageKey = `chat-lite:conversation-activity:${user.id}`;
  const studioStorageKey = `chat-lite:studio-open:${user.id}`;
  const [profile, setProfile] = useState(user);
  const [convs, setConvs] = useState<ConversationDTO[]>([]);
  const [current, setCurrent] = useState<string>();
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, MessageDTO[]>>({});
  const [pendingByConversation, setPendingByConversation] = useState<Record<string, AttachmentDTO[]>>({});
  const [refillByConversation, setRefillByConversation] = useState<Record<string, Refill>>({});
  const [errorsByConversation, setErrorsByConversation] = useState<Record<string, string>>({});
  const [activities, setActivities] = useState<ConversationActivities>(() => parseUnreadActivities(safeGetItem(activityStorageKey)));
  const [, setTaskRevision] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<MessageDTO>();
  const [renameConversationTarget, setRenameConversationTarget] = useState<ConversationDialogTarget>();
  const [deleteConversationTarget, setDeleteConversationTarget] = useState<ConversationDialogTarget>();
  const [drawer, setDrawer] = useState(false);
  const [drawerBackdropVisible, setDrawerBackdropVisible] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [jumpTarget, setJumpTarget] = useState<JumpTarget>();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceFilesDTO>();
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string }>();
  const [studioOpen, setStudioOpen] = useState(() => safeGetItem(studioStorageKey) === '1');
  const [scrollIntent, setScrollIntent] = useState<ScrollIntent>(initialScroll);
  const restoredRef = useRef(false);
  const currentRef = useRef<string | undefined>(undefined);
  const tasksRef = useRef<Map<string, ActiveTask>>(new Map());
  const keyAliasesRef = useRef<Map<string, string>>(new Map());
  const firstUploadConversationRef = useRef<Promise<string> | null>(null);
  const workspaceRequestRef = useRef(0);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchSelectionRef = useRef(0);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const drawerBackdropRef = useRef<HTMLButtonElement | null>(null);
  const drawerGestureRef = useRef<DrawerGesture | null>(null);
  const drawerMotionRef = useRef<DrawerMotion>({ initialized: false, x: 0, progress: 0 });
  const drawerPhaseRef = useRef<DrawerPhase>('idle');
  const drawerSettleRef = useRef<DrawerSettle | null>(null);
  const drawerSettleTokenRef = useRef(0);
  const drawerStateRef = useRef(drawer);
  const drawerClickSuppressionRef = useRef<DrawerClickSuppression | null>(null);
  const drawerClickSuppressionTimerRef = useRef<number | null>(null);
  const [jumpReady, setJumpReady] = useState(false);

  useEffect(() => { drawerStateRef.current = drawer; }, [drawer]);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT}px)`);
    const onViewportChange = () => {
      cancelDrawerGesture();
      cancelDrawerSettle();
      syncDrawerToCommittedState();
    };
    const removeQueryListener = registerMediaQueryChangeListener(query, onViewportChange);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    const visualViewport = window.visualViewport;
    const removeVisualViewportListener = registerVisualViewportResizeListener(visualViewport, onViewportChange);
    syncDrawerToCommittedState();
    return () => {
      removeQueryListener();
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
      removeVisualViewportListener();
    };
  }, []);

  function writeDrawerVisual(panel: HTMLDivElement, backdrop: HTMLButtonElement | null, x: number, progress: number) {
    const safeProgress = clamp(progress, 0, 1);
    panel.style.transform = `translate3d(${x}px, 0, 0)`;
    if (backdrop) backdrop.style.opacity = String(safeProgress);
    drawerMotionRef.current = { initialized: true, x, progress: safeProgress };
  }

  function clearDrawerSettleTimers(settle: DrawerSettle) {
    if (settle.frameId !== null) window.cancelAnimationFrame(settle.frameId);
    if (settle.timerId !== null) window.clearTimeout(settle.timerId);
    settle.frameId = null;
    settle.timerId = null;
  }

  function hideDrawerBackdrop(syncReactState = true) {
    const panel = drawerRef.current;
    const backdrop = drawerBackdropRef.current;
    if (panel) {
      const width = panel.getBoundingClientRect().width;
      const fallbackX = Number.isFinite(drawerMotionRef.current.x) ? drawerMotionRef.current.x : -width;
      const x = readVisualTransformX(panel, fallbackX);
      writeDrawerVisual(panel, backdrop, x, 0);
    } else if (backdrop) {
      backdrop.style.opacity = '0';
    }
    if (backdrop) {
      backdrop.style.visibility = 'hidden';
      backdrop.style.pointerEvents = 'none';
    }
    if (syncReactState) setDrawerBackdropVisible(false);
  }

  function cancelDrawerSettle() {
    const settle = drawerSettleRef.current;
    if (!settle) return;
    const panel = drawerRef.current;
    const backdrop = drawerBackdropRef.current;
    const width = panel?.getBoundingClientRect().width || 1;
    const currentX = panel ? readVisualTransformX(panel, drawerMotionRef.current.x) : drawerMotionRef.current.x;
    const currentProgress = clamp((currentX + width) / width, 0, 1);
    const currentOpacity = backdrop ? readVisualOpacity(backdrop, currentProgress) : currentProgress;
    clearDrawerSettleTimers(settle);
    drawerSettleRef.current = null;
    drawerSettleTokenRef.current += 1;
    drawerPhaseRef.current = 'idle';
    if (panel) {
      panel.style.transition = 'none';
      writeDrawerVisual(panel, backdrop, currentX, currentProgress);
    }
    if (backdrop) {
      backdrop.style.transition = 'none';
      backdrop.style.opacity = String(currentOpacity);
    }
  }

  function completeDrawerSettle(token: number) {
    const settle = drawerSettleRef.current;
    if (!settle || settle.token !== token || drawerPhaseRef.current !== 'settling') return;
    clearDrawerSettleTimers(settle);
    drawerSettleRef.current = null;
    drawerPhaseRef.current = 'idle';
    const panel = drawerRef.current;
    const backdrop = drawerBackdropRef.current;
    if (panel) {
      panel.style.transition = '';
      writeDrawerVisual(panel, backdrop, settle.targetX, settle.targetProgress);
    }
    if (backdrop) backdrop.style.transition = '';
    if (settle.targetOpen) {
      if (backdrop) {
        backdrop.style.visibility = 'visible';
        backdrop.style.pointerEvents = 'auto';
      }
      setDrawerBackdropVisible(true);
    } else {
      hideDrawerBackdrop(true);
    }
  }

  function settleDrawer(targetOpen: boolean, fast = false) {
    const panel = drawerRef.current;
    if (!panel || !window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT}px)`).matches) return;
    cancelDrawerSettle();
    const backdrop = drawerBackdropRef.current;
    const width = panel.getBoundingClientRect().width;
    if (!width) return;
    const fallbackX = Number.isFinite(drawerMotionRef.current.x)
      ? drawerMotionRef.current.x
      : (targetOpen ? -width : 0);
    const currentX = readVisualTransformX(panel, fallbackX);
    const currentProgress = clamp((currentX + width) / width, 0, 1);
    const currentOpacity = backdrop ? readVisualOpacity(backdrop, currentProgress) : currentProgress;
    const targetX = targetOpen ? 0 : -width;
    const targetProgress = targetOpen ? 1 : 0;
    const distanceRatio = clamp(Math.abs(targetX - currentX) / width, 0, 1);
    const reduce = prefersReducedMotion();
    const duration = reduce
      ? 0
      : (fast ? DRAWER_FAST_SETTLE_MIN_DURATION : DRAWER_SETTLE_MIN_DURATION)
        + ((fast ? DRAWER_FAST_SETTLE_MAX_DURATION : DRAWER_SETTLE_MAX_DURATION)
          - (fast ? DRAWER_FAST_SETTLE_MIN_DURATION : DRAWER_SETTLE_MIN_DURATION)) * distanceRatio;
    const token = ++drawerSettleTokenRef.current;
    const settle: DrawerSettle = {
      token,
      targetOpen,
      targetX,
      targetProgress,
      duration,
      frameId: null,
      timerId: null,
    };
    drawerSettleRef.current = settle;
    drawerPhaseRef.current = 'settling';
    panel.style.transition = 'none';
    if (backdrop) backdrop.style.transition = 'none';
    writeDrawerVisual(panel, backdrop, currentX, currentProgress);
    if (backdrop) {
      const visibleDuringSettle = targetOpen || currentOpacity > 0;
      backdrop.style.visibility = visibleDuringSettle ? 'visible' : 'hidden';
      backdrop.style.pointerEvents = visibleDuringSettle ? 'auto' : 'none';
      backdrop.style.opacity = String(currentOpacity);
    }
    if (targetOpen || currentOpacity > 0) setDrawerBackdropVisible(true);
    else hideDrawerBackdrop(true);
    if (duration === 0) {
      writeDrawerVisual(panel, backdrop, targetX, targetProgress);
      completeDrawerSettle(token);
      return;
    }
    const moveToTarget = () => {
      if (drawerSettleRef.current?.token !== token || drawerPhaseRef.current !== 'settling') return;
      panel.style.transition = `transform ${duration * 1000}ms ${targetOpen ? 'cubic-bezier(0.22, 1, 0.36, 1)' : 'cubic-bezier(0.45, 0, 0.55, 1)'}`;
      if (backdrop) backdrop.style.transition = `opacity ${duration * 1000}ms ${targetOpen ? 'cubic-bezier(0.22, 1, 0.36, 1)' : 'cubic-bezier(0.45, 0, 0.55, 1)'}`;
      writeDrawerVisual(panel, backdrop, targetX, targetProgress);
    };
    if (typeof window.requestAnimationFrame === 'function') {
      settle.frameId = window.requestAnimationFrame(moveToTarget);
    } else {
      moveToTarget();
    }
    settle.timerId = window.setTimeout(() => completeDrawerSettle(token), duration * 1000 + 80);
  }

  function syncDrawerToCommittedState() {
    cancelDrawerSettle();
    const panel = drawerRef.current;
    const backdrop = drawerBackdropRef.current;
    const mobile = window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT}px)`).matches;
    drawerPhaseRef.current = 'idle';
    if (!panel || !mobile) {
      if (panel) {
        panel.style.transition = '';
        panel.style.transform = '';
        panel.style.willChange = '';
      }
      if (backdrop) {
        backdrop.style.transition = '';
        backdrop.style.opacity = '';
        backdrop.style.visibility = '';
        backdrop.style.pointerEvents = '';
        backdrop.style.willChange = '';
      }
      drawerMotionRef.current = { initialized: false, x: 0, progress: 0 };
      setDrawerBackdropVisible(false);
      return;
    }
    const width = panel.getBoundingClientRect().width;
    if (!width) return;
    const open = drawerStateRef.current;
    panel.style.transition = 'none';
    if (backdrop) backdrop.style.transition = 'none';
    writeDrawerVisual(panel, backdrop, open ? 0 : -width, open ? 1 : 0);
    if (open) {
      if (backdrop) {
        backdrop.style.visibility = 'visible';
        backdrop.style.pointerEvents = 'auto';
      }
      setDrawerBackdropVisible(true);
    } else {
      hideDrawerBackdrop(true);
    }
    panel.style.transition = '';
    if (backdrop) backdrop.style.transition = '';
  }

  function drawerIsVisuallyOpen() {
    const panel = drawerRef.current;
    if (!panel) return drawerStateRef.current;
    const width = panel.getBoundingClientRect().width;
    if (!width) return drawerStateRef.current;
    const x = readVisualTransformX(panel, -width);
    return clamp((x + width) / width, 0, 1) > 0.02;
  }

  function clearDrawerClickSuppression() {
    const timer = drawerClickSuppressionTimerRef.current;
    if (timer !== null) window.clearTimeout(timer);
    drawerClickSuppressionTimerRef.current = null;
    drawerClickSuppressionRef.current = null;
  }

  function suppressNextDrawerClick(target: Element | null) {
    clearDrawerClickSuppression();
    if (!target) return;
    const expiresAt = Date.now() + 450;
    drawerClickSuppressionRef.current = { target, expiresAt };
    drawerClickSuppressionTimerRef.current = window.setTimeout(() => {
      drawerClickSuppressionRef.current = null;
      drawerClickSuppressionTimerRef.current = null;
    }, expiresAt - Date.now());
  }

  function setDrawerOpen(nextOpen: boolean, fast = false) {
    if (drawerStateRef.current === nextOpen) {
      if (drawerSettleRef.current?.targetOpen === nextOpen) return;
      const visualOpen = drawerIsVisuallyOpen();
      const panel = drawerRef.current;
      const width = panel?.getBoundingClientRect().width || 0;
      const progress = panel && width ? clamp((readVisualTransformX(panel, nextOpen ? -width : 0) + width) / width, 0, 1) : (visualOpen ? 1 : 0);
      const opacity = drawerBackdropRef.current ? readVisualOpacity(drawerBackdropRef.current, visualOpen ? 1 : 0) : visualOpen ? 1 : 0;
      const atTarget = nextOpen ? progress >= 0.999 : progress <= 0.001 && opacity <= 0.001;
      if (atTarget) return;
    }
    drawerStateRef.current = nextOpen;
    setDrawer(nextOpen);
    if (window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT}px)`).matches) settleDrawer(nextOpen, fast);
  }

  function setDragStyles(gesture: DrawerGesture, active: boolean) {
    const panel = drawerRef.current;
    const backdrop = drawerBackdropRef.current;
    if (panel) {
      panel.style.transition = active ? 'none' : gesture.panelTransition;
      panel.style.willChange = active ? 'transform' : gesture.panelWillChange;
    }
    if (backdrop) {
      backdrop.style.transition = active ? 'none' : gesture.backdropTransition;
      backdrop.style.willChange = active ? 'opacity' : gesture.backdropWillChange;
    }
  }

  function releaseDrawerPointer(gesture: DrawerGesture) {
    const captureTarget = gesture.captureTarget;
    if (!captureTarget) return;
    try {
      if (!gesture.captureFailed && !captureTarget.hasPointerCapture(gesture.pointerId)) return;
      captureTarget.releasePointerCapture(gesture.pointerId);
    } catch { /* pointer capture may already be gone */ }
  }

  function clearDrawerGesture(gesture: DrawerGesture) {
    if (gesture.rafId !== null) window.cancelAnimationFrame(gesture.rafId);
    gesture.rafId = null;
    gesture.pendingSample = null;
    clearDrawerMotionSamples(gesture);
    setDragStyles(gesture, false);
    releaseDrawerPointer(gesture);
  }

  function writeDrawerSample(gesture: DrawerGesture, sample: DrawerPointerSample) {
    if (drawerGestureRef.current !== gesture || gesture.phase !== 'dragging') return;
    const panel = drawerRef.current;
    if (!panel) return;
    recordDrawerMotionSample(gesture, sample.clientX, sample.time);
    const dx = sample.clientX - gesture.startX;
    const x = clamp(gesture.startOffset + dx, -gesture.width, 0);
    writeDrawerVisual(panel, drawerBackdropRef.current, x, (x + gesture.width) / gesture.width);
  }

  function flushDrawerSample(gesture: DrawerGesture) {
    if (gesture.rafId !== null) window.cancelAnimationFrame(gesture.rafId);
    gesture.rafId = null;
    const sample = gesture.pendingSample;
    gesture.pendingSample = null;
    if (sample) writeDrawerSample(gesture, sample);
  }

  function scheduleDrawerSample(gesture: DrawerGesture, sample: DrawerPointerSample) {
    gesture.pendingSample = sample;
    if (gesture.rafId !== null) return;
    if (typeof window.requestAnimationFrame !== 'function') {
      flushDrawerSample(gesture);
      return;
    }
    gesture.rafId = window.requestAnimationFrame(() => {
      gesture.rafId = null;
      if (drawerGestureRef.current !== gesture || gesture.phase !== 'dragging') {
        gesture.pendingSample = null;
        return;
      }
      const latest = gesture.pendingSample;
      gesture.pendingSample = null;
      if (latest) writeDrawerSample(gesture, latest);
    });
  }

  function drawerTargetOpen(gesture: DrawerGesture, progress: number) {
    const threshold = gesture.direction === 'open' ? DRAWER_OPEN_THRESHOLD : DRAWER_CLOSE_THRESHOLD;
    return progress >= threshold;
  }

  function cancelDrawerGesture(settleDragging = true) {
    const gesture = drawerGestureRef.current;
    if (!gesture) return;
    const dragging = gesture.phase === 'dragging';
    if (dragging) flushDrawerSample(gesture);
    const progress = clamp(drawerMotionRef.current.progress, 0, 1);
    drawerGestureRef.current = null;
    clearDrawerGesture(gesture);
    drawerPhaseRef.current = 'idle';
    if (dragging && settleDragging) setDrawerOpen(drawerTargetOpen(gesture, progress));
    else if (!dragging) setDrawerOpen(drawerStateRef.current);
  }

  function finishDrawerGesture(latestSample: DrawerPointerSample | null = null) {
    const gesture = drawerGestureRef.current;
    if (!gesture) return;
    const startedOnBackdrop = Boolean(gesture.pointerDownTarget && drawerBackdropRef.current?.contains(gesture.pointerDownTarget));
    const dragging = gesture.phase === 'dragging';
    if (dragging && latestSample) gesture.pendingSample = latestSample;
    if (dragging) flushDrawerSample(gesture);
    const progress = clamp(drawerMotionRef.current.progress, 0, 1);
    if (!dragging) {
      drawerGestureRef.current = null;
      clearDrawerGesture(gesture);
      drawerPhaseRef.current = 'idle';
      if (startedOnBackdrop) setDrawerOpen(false);
      else setDrawerOpen(drawerStateRef.current);
      return;
    }
    const prediction = projectedDrawerProgress(gesture, progress, gesture.width, prefersReducedMotion());
    const targetOpen = drawerTargetOpen(gesture, prediction.progress);
    drawerGestureRef.current = null;
    clearDrawerGesture(gesture);
    drawerPhaseRef.current = 'idle';
    suppressNextDrawerClick(gesture.pointerDownTarget);
    setDrawerOpen(targetOpen, prediction.isFling);
  }

  function handleDrawerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    clearDrawerClickSuppression();
    if (!window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT}px)`).matches || !event.isPrimary || drawerGestureRef.current) return;
    const panel = drawerRef.current;
    const target = event.target instanceof Node ? event.target : null;
    const pointerDownTarget = event.target instanceof Element ? event.target : null;
    const opening = !drawerIsVisuallyOpen();
    const element = target instanceof Element ? target : target?.parentElement || null;
    if (opening ? !isChatContentTarget(element) || isOpenGestureExcluded(element) : isCloseGestureExcluded(element)) return;
    if (!panel) return;
    const width = panel.getBoundingClientRect().width;
    if (!width) return;
    cancelDrawerSettle();
    const currentX = readVisualTransformX(panel, opening ? -width : 0);
    const gesture: DrawerGesture = {
      direction: opening ? 'open' : 'close',
      pointerId: event.pointerId,
      pointerDownTarget,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: clamp(currentX, -width, 0),
      width,
      phase: 'candidate',
      captureTarget: null,
      captureFailed: false,
      panelTransition: panel.style.transition,
      backdropTransition: drawerBackdropRef.current?.style.transition || '',
      previousSampleX: null,
      previousSampleTime: null,
      lastSampleX: null,
      lastSampleTime: null,
      startSampleTime: performance.now(),
      pendingSample: null,
      rafId: null,
      panelWillChange: panel.style.willChange,
      backdropWillChange: drawerBackdropRef.current?.style.willChange || '',
    };
    drawerGestureRef.current = gesture;
    drawerPhaseRef.current = 'candidate';
    let captureTarget: HTMLElement = isPointerCaptureElement(event.target) ? event.target : event.currentTarget;
    let captureFailed = false;
    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      if (captureTarget !== event.currentTarget) {
        captureTarget = event.currentTarget;
        try {
          captureTarget.setPointerCapture(event.pointerId);
        } catch {
          captureFailed = true;
        }
      } else {
        captureFailed = true;
      }
    }
    gesture.captureTarget = captureTarget;
    gesture.captureFailed = captureFailed;
  }

  function handleDrawerPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = drawerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const sample = readLatestDrawerPointerSample(event);
    const dx = sample.clientX - gesture.startX;
    const dy = sample.clientY - gesture.startY;
    if (gesture.phase === 'candidate') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAWER_ACTIVATION_DISTANCE) return;
      if (Math.abs(dy) > Math.abs(dx) || (gesture.direction === 'open' ? dx <= 0 : dx >= 0)) {
        cancelDrawerGesture(false);
        return;
      }
      gesture.phase = 'dragging';
      drawerPhaseRef.current = 'dragging';
      setDragStyles(gesture, true);
      const backdrop = drawerBackdropRef.current;
      if (backdrop) {
        backdrop.style.visibility = 'visible';
        backdrop.style.pointerEvents = gesture.direction === 'open' ? 'none' : 'auto';
      }
    }
    event.preventDefault();
    event.stopPropagation();
    setDragStyles(gesture, true);
    scheduleDrawerSample(gesture, sample);
  }

  function handleDrawerPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = drawerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    finishDrawerGesture(gesture.phase === 'dragging' ? readLatestDrawerPointerSample(event) : null);
  }

  function handleDrawerPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = drawerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    cancelDrawerGesture(true);
  }

  function handleDrawerLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = drawerGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    cancelDrawerGesture(true);
  }

  function suppressDrawerClick(event: ReactMouseEvent<HTMLDivElement>) {
    const suppression = drawerClickSuppressionRef.current;
    if (!suppression) return;
    if (Date.now() >= suppression.expiresAt) {
      clearDrawerClickSuppression();
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!isSameDrawerClickTarget(target, suppression.target)) {
      clearDrawerClickSuppression();
      return;
    }
    clearDrawerClickSuppression();
    event.preventDefault();
    event.stopPropagation();
  }

  useEffect(() => {
    if (!drawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawer]);

  useEffect(() => () => {
    clearDrawerClickSuppression();
    cancelDrawerGesture(false);
    cancelDrawerSettle();
  }, []);

  const currentKey = current || EMPTY_CONVERSATION_KEY;
  const currentConversationId = conversationIdForKey(current);
  const messages = messagesByConversation[currentKey] || [];
  const pending = pendingByConversation[currentKey] || [];
  const refill = refillByConversation[currentKey] || { text: '', key: 0 };
  const currentTask = tasksRef.current.get(currentKey);
  const hasStreamingMessage = messages.some(message => message.status === 'streaming');
  const conversationStreaming = activities[currentKey]?.status === 'streaming' || hasStreamingMessage;
  const interactionBusy = Boolean(currentTask) || conversationStreaming;
  const actionsDisabled = interactionBusy || Boolean(editingMessageId) || Boolean(deleteTarget);
  const err = errorsByConversation[currentKey] || '';

  async function loadWorkspace(conversationId = currentConversationId) {
    if (!conversationId) return;
    const requestId = ++workspaceRequestRef.current;
    setWorkspaceLoading(true);
    setWorkspaceError('');
    setWorkspace(undefined);
    try {
      const nextWorkspace = (await api.workspace(conversationId)).workspace;
      if (requestId === workspaceRequestRef.current && nextWorkspace.conversationId === conversationId) setWorkspace(nextWorkspace);
    } catch (error) {
      if (requestId === workspaceRequestRef.current) setWorkspaceError(error instanceof Error ? error.message : '工作区读取失败');
    } finally {
      if (requestId === workspaceRequestRef.current) setWorkspaceLoading(false);
    }
  }

  function openWorkspace() {
    if (!currentConversationId) return;
    setWorkspaceOpen(true);
  }

  useEffect(() => {
    if (workspaceOpen && currentConversationId) void loadWorkspace(currentConversationId);
  }, [workspaceOpen, currentConversationId]);

  function bumpTasks() {
    setTaskRevision(revision => revision + 1);
  }

  function updateMessages(key: string, update: (messages: MessageDTO[]) => MessageDTO[]) {
    setMessagesByConversation(cache => ({ ...cache, [key]: update(cache[key] || []) }));
  }

  function flushTaskDelta(task: ActiveTask) {
    const pending = drainConversationDelta(task, deltaFlushScheduler);
    if (!pending) return;
    const targetKey = resolveKey(pending.targetKey);
    updateMessages(targetKey, currentMessages => currentMessages.map(message => message.id === pending.assistantId
      ? { ...message, content: message.content + pending.text }
      : message));
  }

  function queueTaskDelta(task: ActiveTask, text: string, targetKey: string, assistantId: string) {
    const delta = { text, targetKey: resolveKey(targetKey), assistantId };
    if (!enqueueConversationDelta(task, delta, deltaFlushScheduler, () => flushTaskDelta(task))) {
      flushTaskDelta(task);
      enqueueConversationDelta(task, delta, deltaFlushScheduler, () => flushTaskDelta(task));
    }
  }

  function setConversationError(key: string, error: string) {
    setErrorsByConversation(errors => error
      ? { ...errors, [key]: error }
      : removeRecordValue(errors, key));
  }

  function resolveKey(key: string) {
    let resolved = key;
    const visited = new Set<string>();
    while (keyAliasesRef.current.has(resolved) && !visited.has(resolved)) {
      visited.add(resolved);
      resolved = keyAliasesRef.current.get(resolved) as string;
    }
    return resolved;
  }

  function setActivity(key: string, status: 'streaming' | 'completed' | 'error') {
    const isOpen = (currentRef.current || EMPTY_CONVERSATION_KEY) === key;
    setActivities(currentActivities => transitionConversationActivity(currentActivities, key, status, isOpen));
  }

  function removeTask(task: ActiveTask) {
    flushTaskDelta(task);
    for (const [key, candidate] of tasksRef.current) {
      if (candidate === task) {
        tasksRef.current.delete(key);
        bumpTasks();
        return;
      }
    }
  }

  function migrateConversationKey(fromKey: string, toKey: string) {
    if (fromKey === toKey) return;
    keyAliasesRef.current.set(fromKey, toKey);
    setMessagesByConversation(cache => moveRecordValue(cache, fromKey, toKey));
    setPendingByConversation(cache => moveRecordValue(cache, fromKey, toKey));
    setRefillByConversation(cache => moveRecordValue(cache, fromKey, toKey));
    setErrorsByConversation(cache => moveRecordValue(cache, fromKey, toKey));
    setActivities(currentActivities => migrateConversationActivity(currentActivities, fromKey, toKey));
    const task = tasksRef.current.get(fromKey);
    if (task) {
      tasksRef.current.delete(fromKey);
      tasksRef.current.set(toKey, task);
      bumpTasks();
    }
    if ((currentRef.current || EMPTY_CONVERSATION_KEY) === fromKey) {
      currentRef.current = toKey;
      setCurrent(toKey);
    }
  }

  async function ensureUploadConversation(uploadKey: string) {
    const existing = conversationIdForKey(uploadKey);
    if (existing) return existing;
    if (!firstUploadConversationRef.current) {
      firstUploadConversationRef.current = (async () => {
        const conversation = (await api.createConversation()).conversation;
        setConvs(currentConversations => [conversation, ...currentConversations]);
        migrateConversationKey(uploadKey, conversation.id);
        return conversation.id;
      })();
    }
    const pending = firstUploadConversationRef.current;
    try {
      return await pending;
    } finally {
      if (firstUploadConversationRef.current === pending) firstUploadConversationRef.current = null;
    }
  }

  function removeConversationState(key: string) {
    const task = tasksRef.current.get(key);
    if (task) {
      flushTaskDelta(task);
      task.controller.abort();
    }
    tasksRef.current.delete(key);
    setMessagesByConversation(cache => removeRecordValue(cache, key));
    setPendingByConversation(cache => removeRecordValue(cache, key));
    setRefillByConversation(cache => removeRecordValue(cache, key));
    setErrorsByConversation(cache => removeRecordValue(cache, key));
    setActivities(currentActivities => removeConversationActivity(currentActivities, key));
    bumpTasks();
  }

  function clearDeletedConversation(conversationId: string) {
    removeConversationState(conversationId);
    if (currentRef.current === conversationId) {
      currentRef.current = undefined;
      keyAliasesRef.current.delete(EMPTY_CONVERSATION_KEY);
      safeRemoveItem(storageKey);
      setCurrent(undefined);
    }
  }

  const refreshConversations = async () => {
    const result = await api.listConversations();
    setConvs(result.conversations);
    return result.conversations;
  };

  const refreshMessages = async (conversationId?: string, propagateError = false, isRelevant?: () => boolean) => {
    if (!conversationId) return;
    if (tasksRef.current.has(conversationId)) return messagesByConversation[conversationId];
    const result = await api.messages(conversationId).catch(error => {
      if (isRelevant && !isRelevant()) return undefined;
      if (error instanceof Error && /404|会话不存在|文件不存在/.test(error.message)) {
        clearDeletedConversation(conversationId);
      }
      if (propagateError) throw error;
      return undefined;
    });
    if (result && (!isRelevant || isRelevant()) && !tasksRef.current.has(conversationId)) {
      setMessagesByConversation(cache => ({ ...cache, [conversationId]: result.messages }));
      setActivities(currentActivities => {
        if (result.messages.some(message => message.status === 'streaming')) {
          return transitionConversationActivity(
            currentActivities,
            conversationId,
            'streaming',
            currentRef.current === conversationId
          );
        }
        if (currentActivities[conversationId]?.status !== 'streaming') return currentActivities;
        const latestAssistant = [...result.messages].reverse().find(message => message.role === 'assistant');
        if (latestAssistant?.status === 'completed') {
          return transitionConversationActivity(currentActivities, conversationId, 'completed', currentRef.current === conversationId);
        }
        if (latestAssistant?.status === 'error' || latestAssistant?.status === 'interrupted') {
          return transitionConversationActivity(currentActivities, conversationId, 'error', currentRef.current === conversationId);
        }
        return currentActivities;
      });
    }
    return result?.messages;
  };

  const refreshAll = async () => {
    const list = await refreshConversations();
    const active = conversationIdForKey(currentRef.current);
    if (active && !list.some(conversation => conversation.id === active)) {
      clearDeletedConversation(active);
      return;
    }
    await refreshMessages(active);
  };

  useEffect(() => { currentRef.current = current; }, [current]);

  useEffect(() => {
    if (currentConversationId) safeSetItem(storageKey, currentConversationId);
  }, [currentConversationId, storageKey]);

  useEffect(() => {
    safeSetItem(activityStorageKey, serializeUnreadActivities(activities));
  }, [activities, activityStorageKey]);

  useEffect(() => {
    if (studioOpen) safeSetItem(studioStorageKey, '1');
    else safeRemoveItem(studioStorageKey);
  }, [studioOpen, studioStorageKey]);

  useEffect(() => {
    if (!current) return;
    setActivities(currentActivities => clearConversationUnread(currentActivities, current));
  }, [current]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      const list = await refreshConversations();
      const saved = safeGetItem(storageKey);
      if (saved && list.some(conversation => conversation.id === saved)) {
        setScrollIntent(initialScroll);
        currentRef.current = saved;
        setCurrent(saved);
      } else if (!saved && list.length === 1) {
        setScrollIntent(initialScroll === 'bottom' ? 'bottom' : 'restore');
        currentRef.current = list[0].id;
        setCurrent(list[0].id);
      }
    })().catch(error => setConversationError(EMPTY_CONVERSATION_KEY, error instanceof Error ? error.message : '会话加载失败'));
  }, [initialScroll, storageKey]);

  useEffect(() => {
    setEditingMessageId(undefined);
    setDeleteTarget(undefined);
    const conversationId = conversationIdForKey(current);
    if (conversationId) void refreshMessages(conversationId);
  }, [current]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      const onFocus = () => { void refreshAll().catch(() => undefined); };
      window.addEventListener('focus', onFocus);
      return () => window.removeEventListener('focus', onFocus);
    }

    const events = new EventSource('/api/events', { withCredentials: true });
    const onConversationsChanged = () => { void refreshConversations().catch(() => undefined); };
    const onMessagesChanged = (event: MessageEvent) => {
      const data = parseEventData(event);
      const conversationId = data.conversationId;
      if (!conversationId) return;
      const hasLocalTask = tasksRef.current.has(conversationId);
      if (!hasLocalTask) {
        if (data.reason === 'user_message' || data.reason === 'user_message_edited') setActivity(conversationId, 'streaming');
        if (data.reason === 'assistant_completed') setActivity(conversationId, 'completed');
        if (data.reason === 'assistant_error' || data.reason === 'assistant_interrupted') setActivity(conversationId, 'error');
        void refreshMessages(conversationId).catch(() => undefined);
      }
      void refreshConversations().catch(() => undefined);
    };
    const onConversationDeleted = (event: MessageEvent) => {
      const data = parseEventData(event);
      if (!data.conversationId) return;
      clearDeletedConversation(data.conversationId);
      void refreshConversations().catch(() => undefined);
    };
    const onFocus = () => { void refreshAll().catch(() => undefined); };

    events.addEventListener('conversations_changed', onConversationsChanged);
    events.addEventListener('messages_changed', onMessagesChanged);
    events.addEventListener('conversation_deleted', onConversationDeleted);
    window.addEventListener('focus', onFocus);
    events.onerror = () => { /* EventSource auto-reconnects; focus refresh remains as fallback. */ };

    return () => {
      events.close();
      window.removeEventListener('focus', onFocus);
    };
  }, [storageKey]);

  useEffect(() => {
    const abortTasks = () => {
      for (const task of tasksRef.current.values()) {
        flushTaskDelta(task);
        task.controller.abort();
      }
      tasksRef.current.clear();
    };
    window.addEventListener('pagehide', abortTasks);
    return () => {
      window.removeEventListener('pagehide', abortTasks);
      abortTasks();
    };
  }, []);

  async function consumeStream(options: StreamOptions) {
    let assistantMessageId = options.tempAssistantId;
    let thinkStarted = false;
    let thinkClosed = false;
    let terminalEvent = false;

    try {
      await streamChat(options.conversationId, options.text, options.attachmentIds, (event, data) => {
      if (event !== 'delta') flushTaskDelta(options.task);
      if (event === 'meta') {
        assistantMessageId = data.messageId || assistantMessageId;
        options.task.assistantId = assistantMessageId;
        options.alignMeta(data, assistantMessageId);
      }
      const targetKey = options.getTargetKey();
      if (event === 'think') {
        const reopenThink = thinkStarted && thinkClosed;
        thinkStarted = true;
        if (reopenThink) thinkClosed = false;
        updateMessages(targetKey, currentMessages => currentMessages.map(message => {
          if (message.id !== assistantMessageId) return message;
          const prefix = !message.content || reopenThink ? '<think>\n' : '';
          return { ...message, content: `${message.content}${prefix}${data.text || ''}\n` };
        }));
      }
      if (event === 'delta') {
        const prefix = thinkStarted && !thinkClosed ? '</think>\n\n' : '';
        thinkClosed = thinkStarted || thinkClosed;
        queueTaskDelta(options.task, prefix + (data.text || ''), targetKey, assistantMessageId);
      }
      if (event === 'execution' && data.code !== undefined) {
        const execution = encodeExecutionBlock({
          language: data.language || 'python',
          code: data.code,
          output: data.output || '',
        });
        const prefix = thinkStarted && !thinkClosed ? '</think>\n\n' : '';
        thinkClosed = thinkStarted || thinkClosed;
        updateMessages(targetKey, currentMessages => currentMessages.map(message => message.id === assistantMessageId
          ? { ...message, content: `${message.content}${prefix}${execution}\n\n` }
          : message));
      }
      if (event === 'done') {
        terminalEvent = true;
        updateMessages(targetKey, currentMessages => currentMessages.map(message => {
          if (message.id !== assistantMessageId) return message;
          const content = thinkStarted && !thinkClosed ? `${message.content}</think>` : message.content;
          return { ...message, content, status: 'completed' };
        }));
        setActivity(targetKey, 'completed');
        window.setTimeout(() => { void refreshConversations().catch(() => undefined); }, 1600);
        window.setTimeout(() => { void refreshConversations().catch(() => undefined); }, 5000);
      }
      if (event === 'cancelled') {
        terminalEvent = true;
        updateMessages(targetKey, currentMessages => currentMessages.map(message => message.id === assistantMessageId
          ? { ...message, content: message.content || '已取消', status: 'interrupted' }
          : message));
        setActivity(targetKey, 'error');
      }
      if (event === 'error') {
        terminalEvent = true;
        const errorText = data.error || '请求失败';
        setConversationError(targetKey, errorText);
        updateMessages(targetKey, currentMessages => currentMessages.map(message => {
          if (message.id !== assistantMessageId) return message;
          const content = `${thinkStarted && !thinkClosed ? `${message.content}</think>\n\n` : message.content}${errorText}`;
          return { ...message, content, status: 'error' };
        }));
        setActivity(targetKey, 'error');
      }
      }, options.task.controller.signal, options.editUserMessageId);
    } finally {
      flushTaskDelta(options.task);
    }

    if (!terminalEvent && !options.task.controller.signal.aborted) throw new Error('回答连接已中断');
    return assistantMessageId;
  }

  function cancelCurrentRequest() {
    const key = currentRef.current || EMPTY_CONVERSATION_KEY;
    const task = tasksRef.current.get(key);
    if (!task) return;
    flushTaskDelta(task);
    task.cancelRequested = true;
    task.controller.abort();
    if (task.operation === 'send') {
      setRefillByConversation(refills => ({ ...refills, [key]: { text: task.sentText, key: (refills[key]?.key || 0) + 1 } }));
    }
    updateMessages(key, currentMessages => currentMessages.map(message => message.id === task.assistantId
      ? { ...message, content: message.content || '已取消', status: 'interrupted' }
      : message));
    setActivity(key, 'error');
  }

  async function send(text: string) {
    let targetKey = currentRef.current || EMPTY_CONVERSATION_KEY;
    const conversationId = conversationIdForKey(targetKey);
    const targetMessages = messagesByConversation[targetKey] || [];
    if (tasksRef.current.has(targetKey) || activities[targetKey]?.status === 'streaming' || targetMessages.some(message => message.status === 'streaming')) return;

    if (!conversationId) {
      const temporaryKey = `${TEMPORARY_CONVERSATION_PREFIX}${crypto.randomUUID()}`;
      migrateConversationKey(targetKey, temporaryKey);
      targetKey = temporaryKey;
    }

    setScrollIntent('follow');
    setConversationError(targetKey, '');
    const controller = new AbortController();
    const attachments = pendingByConversation[currentRef.current || EMPTY_CONVERSATION_KEY] || pendingByConversation[targetKey] || pending;
    setPendingByConversation(cache => ({ ...cache, [targetKey]: [] }));
    const userText = text.trim();
    const userContent = attachments.length ? `${userText}\n\n${attachments.map(attachment => `![${attachment.original_name}](${attachment.public_path})`).join('\n')}` : userText;
    const now = new Date().toISOString();
    const tempUser: MessageDTO = { id: crypto.randomUUID(), conversation_id: conversationId || '', role: 'user', content: userContent, status: 'completed', created_at: now };
    const tempAssistant: MessageDTO = { id: crypto.randomUUID(), conversation_id: conversationId || '', role: 'assistant', content: '', status: 'streaming', created_at: now };
    const task: ActiveTask = {
      controller,
      assistantId: tempAssistant.id,
      sentText: userText,
      operation: 'send',
      cancelRequested: false,
      pendingDelta: '',
      deltaFlushHandle: null,
    };
    tasksRef.current.set(targetKey, task);
    bumpTasks();
    setActivity(targetKey, 'streaming');
    updateMessages(targetKey, currentMessages => [...currentMessages, tempUser, tempAssistant]);

    try {
      await consumeStream({
        conversationId,
        text: userText,
        attachmentIds: attachments.map(attachment => attachment.id),
        tempAssistantId: tempAssistant.id,
        task,
        getTargetKey: () => targetKey,
        alignMeta: (data, assistantMessageId) => {
          if (data.conversationId && data.conversationId !== targetKey) {
            const previousKey = targetKey;
            targetKey = data.conversationId;
            migrateConversationKey(previousKey, targetKey);
          }
          updateMessages(targetKey, currentMessages => currentMessages.map(message => {
            if (message.id === tempUser.id) return { ...message, id: data.userMessageId || message.id, conversation_id: data.conversationId || message.conversation_id };
            if (message.id === tempAssistant.id) return { ...message, id: assistantMessageId, conversation_id: data.conversationId || message.conversation_id };
            return message;
          }));
        }
      });
      await refreshConversations();
    } catch (cause) {
      flushTaskDelta(task);
      const cancelled = task.cancelRequested || (cause instanceof DOMException && cause.name === 'AbortError');
      if (cancelled) {
        setRefillByConversation(refills => ({ ...refills, [targetKey]: { text: userText, key: (refills[targetKey]?.key || 0) + 1 } }));
        updateMessages(targetKey, currentMessages => currentMessages.map(message => message.id === task.assistantId
          ? { ...message, content: message.content || '已取消', status: 'interrupted' }
          : message));
      } else {
        const errorText = cause instanceof Error ? cause.message : '发送失败';
        setPendingByConversation(cache => ({ ...cache, [targetKey]: attachments }));
        setConversationError(targetKey, errorText);
        updateMessages(targetKey, currentMessages => currentMessages.map(message => message.id === task.assistantId
          ? { ...message, content: message.content || errorText, status: 'error' }
          : message));
      }
      setActivity(targetKey, 'error');
    } finally {
      flushTaskDelta(task);
      removeTask(task);
      const resolvedConversationId = conversationIdForKey(targetKey);
      if (resolvedConversationId) await refreshMessages(resolvedConversationId).catch(() => undefined);
    }
  }

  function startEdit(message: MessageDTO) {
    if (message.role !== 'user' || actionsDisabled) return;
    setConversationError(message.conversation_id, '');
    setEditingMessageId(message.id);
  }

  async function confirmEdit(message: MessageDTO, text: string) {
    const targetKey = message.conversation_id;
    const baseMessages = messagesByConversation[targetKey] || [];
    if (tasksRef.current.has(targetKey) || activities[targetKey]?.status === 'streaming' || baseMessages.some(candidate => candidate.status === 'streaming')) return;
    const userIndex = baseMessages.findIndex(candidate => candidate.id === message.id && candidate.role === 'user');
    if (userIndex < 0) return;
    const parts = splitUserMessage(message);
    const editedText = text.trim();
    if (!editedText && parts.images.length === 0) return;

    const latestUserIndex = baseMessages.reduce((latest, candidate, index) => candidate.role === 'user' ? index : latest, -1);
    const optimisticMode: EditMode = latestUserIndex === userIndex ? 'replace' : 'append';
    const now = new Date().toISOString();
    const editedContent = composeUserMessage(editedText, parts.images);
    const replacementUser: MessageDTO = { ...message, content: editedContent, status: 'completed' };
    const appendedUser: MessageDTO = { ...replacementUser, id: crypto.randomUUID(), created_at: now };
    const tempAssistant: MessageDTO = { id: crypto.randomUUID(), conversation_id: targetKey, role: 'assistant', content: '', status: 'streaming', created_at: now };
    const optimisticUserId = optimisticMode === 'replace' ? replacementUser.id : appendedUser.id;
    const controller = new AbortController();
    const task: ActiveTask = {
      controller,
      assistantId: tempAssistant.id,
      sentText: editedText,
      operation: 'edit',
      cancelRequested: false,
      pendingDelta: '',
      deltaFlushHandle: null,
    };
    let editAcknowledged = false;

    setEditingMessageId(undefined);
    setDeleteTarget(undefined);
    setConversationError(targetKey, '');
    setScrollIntent(optimisticMode === 'append' ? 'follow' : 'bottom');
    setMessagesByConversation(cache => ({
      ...cache,
      [targetKey]: optimisticMode === 'replace'
        ? replacePair(baseMessages, userIndex, replacementUser, tempAssistant)
        : [...baseMessages, appendedUser, tempAssistant]
    }));
    tasksRef.current.set(targetKey, task);
    bumpTasks();
    setActivity(targetKey, 'streaming');

    try {
      await consumeStream({
        conversationId: targetKey,
        text: editedText,
        attachmentIds: [],
        editUserMessageId: message.id,
        tempAssistantId: tempAssistant.id,
        task,
        getTargetKey: () => targetKey,
        alignMeta: (data, assistantMessageId) => {
          editAcknowledged = true;
          const actualMode = data.mode || optimisticMode;
          const realConversationId = data.conversationId || targetKey;
          if (actualMode !== optimisticMode) {
            const realUser = actualMode === 'replace'
              ? { ...replacementUser, id: data.userMessageId || replacementUser.id, conversation_id: realConversationId }
              : { ...appendedUser, id: data.userMessageId || appendedUser.id, conversation_id: realConversationId };
            setMessagesByConversation(cache => ({
              ...cache,
              [targetKey]: (() => {
                const currentAssistant = (cache[targetKey] || []).find(candidate => candidate.id === tempAssistant.id);
                const realAssistant = {
                  ...tempAssistant,
                  content: currentAssistant?.content || tempAssistant.content,
                  id: assistantMessageId,
                  conversation_id: realConversationId,
                };
                return actualMode === 'replace'
                  ? replacePair(baseMessages, userIndex, realUser, realAssistant)
                  : [...baseMessages, realUser, realAssistant];
              })()
            }));
            return;
          }
          updateMessages(targetKey, currentMessages => currentMessages.map(candidate => {
            if (candidate.id === optimisticUserId) return { ...candidate, id: data.userMessageId || candidate.id, conversation_id: realConversationId };
            if (candidate.id === tempAssistant.id) return { ...candidate, id: assistantMessageId, conversation_id: realConversationId };
            return candidate;
          }));
        }
      });
      await refreshConversations();
    } catch (cause) {
      flushTaskDelta(task);
      if (task.cancelRequested || (cause instanceof DOMException && cause.name === 'AbortError')) {
        updateMessages(targetKey, currentMessages => currentMessages.map(candidate => candidate.id === task.assistantId
          ? { ...candidate, content: candidate.content || '已取消', status: 'interrupted' }
          : candidate));
      } else {
        const errorText = cause instanceof Error ? cause.message : '编辑失败';
        setConversationError(targetKey, errorText);
        updateMessages(targetKey, currentMessages => currentMessages.map(candidate => candidate.id === task.assistantId
          ? { ...candidate, content: candidate.content || errorText, status: 'error' }
          : candidate));
      }
      setActivity(targetKey, 'error');
    } finally {
      flushTaskDelta(task);
      removeTask(task);
      if (editAcknowledged) await refreshMessages(targetKey).catch(() => undefined);
    }
  }

  function requestDelete(message: MessageDTO) {
    if (message.role !== 'user' || actionsDisabled) return;
    setConversationError(message.conversation_id, '');
    setDeleteTarget(message);
  }

  async function deleteMessage() {
    const target = deleteTarget;
    const conversationId = target?.conversation_id;
    if (!target || !conversationId || tasksRef.current.has(conversationId) || activities[conversationId]?.status === 'streaming') {
      throw new Error('当前无法删除消息');
    }
    try {
      const result = await api.deleteMessage(conversationId, target.id);
      if (result.conversationDeleted) {
        clearDeletedConversation(conversationId);
        await refreshConversations();
        return;
      }
      await Promise.all([refreshMessages(conversationId), refreshConversations()]);
    } catch (cause) {
      setConversationError(conversationId, cause instanceof Error ? cause.message : '删除失败');
      throw cause;
    }
  }

  function openStudio() {
    setStudioOpen(true);
    setWorkspaceOpen(false);
    setDrawerOpen(false);
  }

  function selectConversation(id: string) {
    setStudioOpen(false);
    searchSelectionRef.current += 1;
    setEditingMessageId(undefined);
    setDeleteTarget(undefined);
    setJumpTarget(undefined);
    setJumpReady(false);
    setScrollIntent('bottom');
    currentRef.current = id;
    setCurrent(id);
    setActivities(currentActivities => clearConversationUnread(currentActivities, id));
    setDrawerOpen(false);
  }

  async function pinConversation(id: string, pinned: boolean) {
    const errorKey = currentRef.current || EMPTY_CONVERSATION_KEY;
    setConversationError(errorKey, '');
    try {
      await api.pinConversation(id, pinned);
      await refreshConversations();
    } catch (cause) {
      setConversationError(errorKey, cause instanceof Error ? cause.message : '置顶操作失败');
      throw cause;
    }
  }

  async function renameConversation(id: string, title: string) {
    const errorKey = currentRef.current || EMPTY_CONVERSATION_KEY;
    setConversationError(errorKey, '');
    try {
      await api.renameConversation(id, title);
      await refreshConversations();
    } catch (cause) {
      setConversationError(errorKey, cause instanceof Error ? cause.message : '重命名失败');
      throw cause;
    }
  }

  async function deleteConversation(id: string) {
    const errorKey = currentRef.current || EMPTY_CONVERSATION_KEY;
    if (activities[id]?.status === 'streaming') throw new Error('请先停止生成');
    setConversationError(errorKey, '');
    try {
      await api.deleteConversation(id);
      clearDeletedConversation(id);
      await refreshConversations();
    } catch (cause) {
      setConversationError(errorKey, cause instanceof Error ? cause.message : '删除会话失败');
      throw cause;
    }
  }

  function selectSearchResult(result: SearchMessageResultDTO) {
    const conversationId = result.conversationId;
    const selectionId = ++searchSelectionRef.current;
    const isSelectionActive = () => searchSelectionRef.current === selectionId;
    const isViewCurrent = () => isSelectionActive() && currentRef.current === conversationId;
    setSearchOpen(false);
    setStudioOpen(false);
    setDrawerOpen(false);
    setEditingMessageId(undefined);
    setDeleteTarget(undefined);
    setJumpTarget(undefined);
    setJumpReady(false);
    setScrollIntent('restore');
    setConversationError(conversationId, '');
    currentRef.current = conversationId;
    setCurrent(conversationId);
    setActivities(currentActivities => clearConversationUnread(currentActivities, conversationId));

    const cachedMessages = messagesByConversation[conversationId];
    setJumpTarget({ conversationId, messageId: result.messageId });
    if (cachedMessages?.some(message => message.id === result.messageId)) {
      setJumpReady(true);
      return;
    }

    void refreshMessages(conversationId, true, isViewCurrent).then(loadedMessages => {
      if (!isViewCurrent()) return;
      if (loadedMessages?.some(message => message.id === result.messageId)) {
        setJumpReady(true);
      } else {
        setJumpTarget(undefined);
        setConversationError(conversationId, '消息已不存在');
      }
    }).catch(cause => {
      if (!isSelectionActive()) return;
      const missing = cause instanceof Error && /404|会话不存在|文件不存在/.test(cause.message);
      setJumpTarget(undefined);
      const targetKey = currentRef.current === conversationId ? conversationId : EMPTY_CONVERSATION_KEY;
      setConversationError(targetKey, missing ? '消息已不存在' : (cause instanceof Error ? cause.message : '消息加载失败'));
    });
  }

  function abortAllTasks() {
    for (const task of tasksRef.current.values()) {
      flushTaskDelta(task);
      task.controller.abort();
    }
    tasksRef.current.clear();
    bumpTasks();
  }

  return (
    <div
      className="app"
      onPointerDown={handleDrawerPointerDown}
      onPointerMove={handleDrawerPointerMove}
      onPointerUp={handleDrawerPointerUp}
      onPointerCancel={handleDrawerPointerCancel}
      onLostPointerCapture={handleDrawerLostPointerCapture}
      onClickCapture={suppressDrawerClick}
    >
      <header className="topbar">
        <button className="icon-button menu-button" aria-label={drawer ? '关闭会话' : '打开会话'} aria-expanded={drawer} onClick={() => setDrawerOpen(!drawer)}>☰</button>
        <strong className="brand">chat-lite</strong>
        <span className="user-email">{profile.email}</span>
        <ProfileMenu user={profile} onUserChange={setProfile} onLogout={() => { abortAllTasks(); onLogout(); }} />
      </header>
      <div className="layout">
        <button ref={drawerBackdropRef} className={drawerBackdropVisible ? 'drawer-backdrop is-open' : 'drawer-backdrop'} aria-label="关闭会话" onClick={() => setDrawerOpen(false)} />
        <div ref={drawerRef} className={drawer ? 'drawer open' : 'drawer'}>
          <ConversationList
            conversations={convs}
            currentId={currentConversationId}
            statuses={activities}
            searchTriggerRef={searchTriggerRef}
            studioOpen={studioOpen}
            onOpenStudio={openStudio}
            onSearch={() => setSearchOpen(true)}
            onSelect={selectConversation}
            onNew={async () => {
              const conversation = (await api.createConversation()).conversation;
              setConvs(currentConversations => [
                ...currentConversations.filter(candidate => candidate.pinned_at),
                conversation,
                ...currentConversations.filter(candidate => !candidate.pinned_at),
              ]);
              selectConversation(conversation.id);
            }}
            onPin={pinConversation}
            onRename={(conversation, trigger) => setRenameConversationTarget({ conversation, trigger })}
            onDelete={(conversation, trigger) => setDeleteConversationTarget({ conversation, trigger })}
          />
        </div>
        <main className="chat">
          {studioOpen ? <ImageStudioPage /> : <>
          {err && <div className="error app-error">{err}</div>}
          <MessageList
            messages={messages}
            conversationId={current}
            storageKey={`chat-lite:scroll:${user.id}:${currentKey}`}
            scrollIntent={scrollIntent}
            editingMessageId={editingMessageId}
            actionsDisabled={actionsDisabled}
            editorDisabled={interactionBusy}
            onEdit={startEdit}
            onCancelEdit={() => setEditingMessageId(undefined)}
            onConfirmEdit={(message, text) => void confirmEdit(message, text)}
            onDelete={requestDelete}
            onImageClick={(src, alt) => setImagePreview({ src, alt })}
            jumpMessageId={jumpTarget && jumpTarget.conversationId === currentConversationId ? jumpTarget.messageId : undefined}
            jumpReady={jumpReady}
            onJumpComplete={found => {
              const target = jumpTarget;
              setJumpTarget(undefined);
              setJumpReady(false);
              if (!found && target) setConversationError(target.conversationId, '消息已不存在');
            }}
          />
          <MessageInput
            conversationId={currentConversationId}
            onWorkspace={openWorkspace}
            disabled={interactionBusy || Boolean(editingMessageId) || Boolean(deleteTarget)}
            sending={Boolean(currentTask)}
            refillText={refill.text}
            refillKey={refill.key}
            pending={pending}
            onSend={send}
            onCancel={cancelCurrentRequest}
            onRemoveImage={id => setPendingByConversation(cache => ({
              ...cache,
              [currentKey]: (cache[currentKey] || []).filter(attachment => attachment.id !== id)
            }))}
            onPreviewImage={(src, alt) => setImagePreview({ src, alt })}
            onImage={async file => {
              const uploadKey = currentRef.current || EMPTY_CONVERSATION_KEY;
              try {
                const conversationId = await ensureUploadConversation(uploadKey);
                const result = await api.upload(file, conversationId);
                const targetKey = resolveKey(uploadKey);
                setPendingByConversation(cache => ({ ...cache, [targetKey]: [...(cache[targetKey] || []), result.attachment] }));
              } catch (cause) {
                setConversationError(resolveKey(uploadKey), cause instanceof Error ? cause.message : '上传失败');
              }
            }}
          />
        <WorkspaceDialog
          open={workspaceOpen}
          conversationId={currentConversationId}
          workspace={workspace}
          loading={workspaceLoading}
          error={workspaceError}
          onClose={() => setWorkspaceOpen(false)}
          onRefresh={() => { void loadWorkspace(); }}
          onPreview={file => setImagePreview({ src: file.previewUrl || file.url, alt: file.name })}
        />
        {imagePreview && <ImageLightbox src={imagePreview.src} alt={imagePreview.alt} onClose={() => setImagePreview(undefined)} />}
          </>}
        </main>
      </div>
      <ConversationSearch
        open={searchOpen}
        triggerRef={searchTriggerRef}
        onClose={() => setSearchOpen(false)}
        onSelect={selectSearchResult}
      />
      {renameConversationTarget && <RenameConversationDialog
        key={renameConversationTarget.conversation.id}
        open
        conversation={renameConversationTarget.conversation}
        trigger={renameConversationTarget.trigger}
        onClose={() => setRenameConversationTarget(undefined)}
        onConfirm={title => renameConversation(renameConversationTarget.conversation.id, title)}
      />}
      {deleteConversationTarget && <DeleteConversationDialog
        key={deleteConversationTarget.conversation.id}
        open
        conversation={deleteConversationTarget.conversation}
        trigger={deleteConversationTarget.trigger}
        streaming={activities[deleteConversationTarget.conversation.id]?.status === 'streaming'}
        onClose={() => setDeleteConversationTarget(undefined)}
        onConfirm={() => deleteConversation(deleteConversationTarget.conversation.id)}
      />}
      <DeleteMessageDialog key={deleteTarget?.id || 'closed'} open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(undefined)} onConfirm={deleteMessage} />
    </div>
  );
}
