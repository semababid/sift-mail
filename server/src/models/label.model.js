import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

const labelSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    // The name lowercased. It exists only to keep names unique per user
    // whatever their case, so "Uni" and "uni" cannot both exist. Filled in from
    // name on every validate, so no code path has to remember to set it.
    nameKey: { type: String, required: true, select: false },
    color: { type: String, default: '#6b7280' },
  },
  { timestamps: true },
);

labelSchema.pre('validate', function setNameKey() {
  if (typeof this.name === 'string') this.nameKey = this.name.trim().toLowerCase();
});

// One name per user regardless of case, and the lookup for the sidebar.
labelSchema.index({ userId: 1, nameKey: 1 }, { unique: true });

labelSchema.plugin(toJSON);

export const Label = mongoose.model('Label', labelSchema);
