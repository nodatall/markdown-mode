import type { CriticComment } from "./critic-markup";

interface CommentAnchorMeasurement {
  commentIds: string[];
  anchorLeft?: number;
  anchorRight?: number;
  anchorTop: number;
  anchorBottom: number;
}

export interface CommentGroupAnchor {
  key: string;
  commentIds: string[];
  anchorLeft?: number;
  anchorRight?: number;
  anchorTop: number;
  anchorBottom: number;
}

interface CommentRailLayout extends CommentGroupAnchor {
  railTop: number;
  railBottom: number;
  height: number;
}

export interface CommentThreadRailItem {
  key: string;
  anchorGroupKey: string;
  rootCommentId: string;
  commentIds: string[];
  anchorTop: number;
  anchorBottom: number;
}

interface CommentThreadRailLayout extends CommentThreadRailItem {
  railTop: number;
  railBottom: number;
  height: number;
}

interface AnchoredRailItem {
  key: string;
  anchorTop: number;
  anchorBottom: number;
}

export type AnchoredRailLayout<T extends AnchoredRailItem> = T & {
  railTop: number;
  railBottom: number;
  height: number;
};

interface CommentAnchorElementLike {
  dataset: {
    commentIds?: string;
  };
  getBoundingClientRect: () => {
    left?: number;
    right?: number;
    top: number;
    bottom: number;
  };
  getClientRects?: () => Iterable<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>;
}

export function normalizeCommentMeasurement(
  value: number,
  measurementScale = 1,
) {
  if (!Number.isFinite(measurementScale) || measurementScale <= 0) {
    return value;
  }

  return value / measurementScale;
}

export function parseCommentIds(value: string | null | undefined): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((entry): entry is string => typeof entry === "string"),
      ),
    ];
  } catch {
    return [];
  }
}

function getCommentGroupKey(commentIds: string[]): string {
  return [...new Set(commentIds)].sort().join("::");
}

export function getPreferredCommentId(
  commentIds: string[],
  currentCommentId: string | null,
): string | null {
  if (currentCommentId && commentIds.includes(currentCommentId)) {
    return currentCommentId;
  }

  return commentIds[0] ?? null;
}

export function expandCommentIdsForLegacyReferences(
  commentIds: string[],
  comments: ReadonlyMap<string, CriticComment>,
): string[] {
  const visibleIds = new Set(
    commentIds.filter((commentId) => comments.has(commentId)),
  );
  let changed = true;

  while (changed) {
    changed = false;

    for (const comment of comments.values()) {
      if (visibleIds.has(comment.id)) continue;
      if (!comment.parentCommentId) continue;
      if (!visibleIds.has(comment.parentCommentId)) continue;

      visibleIds.add(comment.id);
      changed = true;
    }
  }

  return [...comments.values()]
    .map((comment) => comment.id)
    .filter((commentId) => visibleIds.has(commentId));
}

export function getRootThreadIdForCommentId(
  commentId: string | null,
  comments: ReadonlyMap<string, CriticComment>,
): string | null {
  if (!commentId) return null;
  return comments.has(commentId) ? commentId : null;
}

export function getCommentAnchorMeasurements(
  anchorElements: Iterable<CommentAnchorElementLike>,
  containerTop: number,
  containerLeft = 0,
  measurementScale = 1,
): CommentAnchorMeasurement[] {
  const measurements: CommentAnchorMeasurement[] = [];

  for (const element of anchorElements) {
    const commentIds = parseCommentIds(element.dataset.commentIds);
    if (commentIds.length === 0) continue;

    const rect = element.getBoundingClientRect();
    const rects = [...(element.getClientRects?.() ?? [])];
    const terminalRect = rects.at(-1) ?? rect;
    measurements.push({
      commentIds,
      anchorLeft:
        rect.left === undefined
          ? undefined
          : normalizeCommentMeasurement(
              rect.left - containerLeft,
              measurementScale,
            ),
      anchorRight:
        terminalRect.right === undefined
          ? undefined
          : normalizeCommentMeasurement(
              terminalRect.right - containerLeft,
              measurementScale,
            ),
      anchorTop: normalizeCommentMeasurement(
        rect.top - containerTop,
        measurementScale,
      ),
      anchorBottom: normalizeCommentMeasurement(
        rect.bottom - containerTop,
        measurementScale,
      ),
    });
  }

  return measurements;
}

export function groupCommentAnchorMeasurements(
  measurements: CommentAnchorMeasurement[],
): CommentGroupAnchor[] {
  const grouped = new Map<string, CommentGroupAnchor>();

  for (const measurement of measurements) {
    const key = getCommentGroupKey(measurement.commentIds);
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        key,
        commentIds: measurement.commentIds,
        anchorLeft: measurement.anchorLeft,
        anchorRight: measurement.anchorRight,
        anchorTop: measurement.anchorTop,
        anchorBottom: measurement.anchorBottom,
      });
      continue;
    }

    existing.anchorTop = Math.min(existing.anchorTop, measurement.anchorTop);
    existing.anchorLeft =
      existing.anchorLeft === undefined
        ? measurement.anchorLeft
        : measurement.anchorLeft === undefined
          ? existing.anchorLeft
          : Math.min(existing.anchorLeft, measurement.anchorLeft);
    existing.anchorRight = measurement.anchorRight ?? existing.anchorRight;
    existing.anchorBottom = Math.max(
      existing.anchorBottom,
      measurement.anchorBottom,
    );
  }

  return [...grouped.values()].sort(
    (left, right) => left.anchorTop - right.anchorTop,
  );
}

export function buildCommentThreadRailItems(
  groups: CommentGroupAnchor[],
  comments: ReadonlyMap<string, CriticComment>,
): CommentThreadRailItem[] {
  const items: CommentThreadRailItem[] = [];

  for (const group of groups) {
    const visibleCommentIds = expandCommentIdsForLegacyReferences(
      group.commentIds,
      comments,
    );

    if (visibleCommentIds.length === 0) continue;

    items.push({
      key: group.key,
      anchorGroupKey: group.key,
      rootCommentId: visibleCommentIds[0] ?? group.key,
      commentIds: visibleCommentIds,
      anchorTop: group.anchorTop,
      anchorBottom: group.anchorBottom,
    });
  }

  return items;
}

export function resolveCommentRailLayouts(
  groups: CommentGroupAnchor[],
  heights: Record<string, number>,
  gap = 16,
): CommentRailLayout[] {
  let previousRailBottom = 0;

  return groups.map((group) => {
    const height = heights[group.key] ?? 120;
    const railTop = Math.max(
      group.anchorTop,
      previousRailBottom === 0 ? group.anchorTop : previousRailBottom + gap,
    );
    const railBottom = railTop + height;
    previousRailBottom = railBottom;

    return {
      ...group,
      railTop,
      railBottom,
      height,
    };
  });
}

export function resolveAnchoredRailLayouts<T extends AnchoredRailItem>(
  items: T[],
  heights: Record<string, number>,
  activeKey: string | null,
  gap = 16,
  defaultHeight = 120,
): Array<AnchoredRailLayout<T>> {
  if (items.length === 0) return [];

  const activeIndex = Math.max(
    0,
    activeKey ? items.findIndex((item) => item.key === activeKey) : 0,
  );

  const resolved = new Array<AnchoredRailLayout<T>>(items.length);
  const getHeight = (item: T) => heights[item.key] ?? defaultHeight;

  const activeItem = items[activeIndex] ?? items[0];
  if (!activeItem) return [];

  const activeHeight = getHeight(activeItem);
  resolved[activeIndex] = {
    ...activeItem,
    railTop: activeItem.anchorTop,
    railBottom: activeItem.anchorTop + activeHeight,
    height: activeHeight,
  };

  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const item = items[index];
    const nextLayout = resolved[index + 1];

    if (!item || !nextLayout) continue;

    const height = getHeight(item);
    const railTop = Math.min(item.anchorTop, nextLayout.railTop - gap - height);

    resolved[index] = {
      ...item,
      railTop,
      railBottom: railTop + height,
      height,
    };
  }

  for (let index = activeIndex + 1; index < items.length; index += 1) {
    const item = items[index];
    const previousLayout = resolved[index - 1];

    if (!item || !previousLayout) continue;

    const height = getHeight(item);
    const railTop = Math.max(item.anchorTop, previousLayout.railBottom + gap);

    resolved[index] = {
      ...item,
      railTop,
      railBottom: railTop + height,
      height,
    };
  }

  const firstRailTop = resolved[0]?.railTop ?? 0;
  if (firstRailTop < 0) {
    const offset = -firstRailTop;
    return resolved.map((layout) => ({
      ...layout,
      railTop: layout.railTop + offset,
      railBottom: layout.railBottom + offset,
    }));
  }

  return resolved;
}

export function resolveCommentThreadRailLayouts(
  items: CommentThreadRailItem[],
  heights: Record<string, number>,
  selectedRootThreadId: string | null,
  gap = 16,
): CommentThreadRailLayout[] {
  const activeItem =
    selectedRootThreadId == null
      ? null
      : (items.find((item) => item.rootCommentId === selectedRootThreadId) ??
        null);

  return resolveAnchoredRailLayouts(
    items,
    heights,
    activeItem?.key ?? null,
    gap,
  );
}
