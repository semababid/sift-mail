import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

const labelSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    color: { type: String, default: '#6b7280' },
  },
  { timestamps: true },
);

labelSchema.plugin(toJSON);

export const Label = mongoose.model('Label', labelSchema);
