import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // The hash stays out of every normal query. Auth asks for it explicitly.
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true },
    settings: {
      messagesPerPage: { type: Number, default: 50 },
      blockRemoteImages: { type: Boolean, default: true },
    },
  },
  { timestamps: true },
);

userSchema.plugin(toJSON);

export const User = mongoose.model('User', userSchema);
