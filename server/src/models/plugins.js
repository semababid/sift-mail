// Every document goes out as `id` rather than `_id`, without `__v`, and without
// anything the schema marked `select: false` that happened to get loaded.
export function toJSON(schema) {
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform(doc, ret) {
      ret.id = ret._id?.toString();
      delete ret._id;
      for (const [path, opts] of Object.entries(schema.paths)) {
        if (opts.options?.select === false) delete ret[path];
      }
      return ret;
    },
  });
}
