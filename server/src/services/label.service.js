import { Label, Thread } from '../models/index.js';
import { HIDDEN_FROM_LABELS } from '../lib/constants.js';
import { conflict, notFound } from '../lib/errors.js';

const duplicateName = () => conflict('a label with that name already exists', 'label_exists');

async function findOwnLabel(userId, labelId) {
  const label = await Label.findOne({ _id: labelId, userId });
  if (!label) throw notFound('label not found');
  return label;
}

// Labels for the sidebar, each with how many conversations carry it and how
// many of those are unread. Sorted with German collation, so "ärztlich" sits
// next to "Arbeit" instead of after "Zahlungen", where a byte-order sort
// would put it.
export async function listLabels(userId) {
  const labels = await Label.find({ userId }).collation({ locale: 'de' }).sort({ name: 1 });
  if (labels.length === 0) return [];

  const labelIds = labels.map((l) => l._id);
  const counts = await Thread.aggregate([
    {
      $match: {
        userId,
        labelIds: { $in: labelIds },
        folders: { $elemMatch: { $nin: HIDDEN_FROM_LABELS } },
      },
    },
    { $unwind: '$labelIds' },
    { $match: { labelIds: { $in: labelIds } } },
    {
      $group: {
        _id: '$labelIds',
        threadCount: { $sum: 1 },
        unreadCount: { $sum: { $cond: ['$hasUnread', 1, 0] } },
      },
    },
  ]);

  const byId = new Map(counts.map((c) => [String(c._id), c]));
  return labels.map((label) => {
    const count = byId.get(String(label._id));
    return {
      ...label.toJSON(),
      threadCount: count?.threadCount ?? 0,
      unreadCount: count?.unreadCount ?? 0,
    };
  });
}

export async function createLabel(userId, { name, color }) {
  try {
    return await Label.create({ userId, name, color });
  } catch (err) {
    if (err.code === 11000) throw duplicateName();
    throw err;
  }
}

export async function updateLabel(userId, labelId, { name, color }) {
  const label = await findOwnLabel(userId, labelId);
  if (name !== undefined) label.name = name;
  if (color !== undefined) label.color = color;

  // Renaming "uni" to "Uni" is allowed: the unique index compares the
  // lowercased key, and that key still belongs to this same label.
  try {
    return await label.save();
  } catch (err) {
    if (err.code === 11000) throw duplicateName();
    throw err;
  }
}

export async function deleteLabel(userId, labelId) {
  const label = await findOwnLabel(userId, labelId);

  // Off every thread first. If the delete below then failed, the worst left
  // behind is an unused label in the sidebar, not threads pointing at one that
  // no longer exists.
  await Thread.updateMany({ userId, labelIds: label._id }, { $pull: { labelIds: label._id } });
  await label.deleteOne();
}
