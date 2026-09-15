// The folders the server knows, in the order the sidebar lists them.
export const FOLDERS = [
  { id: 'inbox', name: 'Inbox' },
  { id: 'sent', name: 'Sent' },
  { id: 'drafts', name: 'Drafts' },
  { id: 'archive', name: 'Archive' },
  { id: 'spam', name: 'Spam' },
  { id: 'trash', name: 'Trash' },
];

export const folderName = (id) => FOLDERS.find((folder) => folder.id === id)?.name ?? null;
