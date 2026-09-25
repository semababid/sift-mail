const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayAndMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const numericDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateAndTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// The date column of the list: the time for mail from today, day and month for
// earlier this year, and the full date for anything older.
export function listDate(value, now = new Date()) {
  const date = new Date(value);
  if (sameDay(date, now)) return clock.format(date);
  if (date.getFullYear() === now.getFullYear()) return dayAndMonth.format(date);
  return numericDate.format(date);
}

// The date and time above an open message.
export const messageDate = (value) => dateAndTime.format(new Date(value));

// A person by name, or by address when the mail gave no name. The signed-in
// user is "me".
export function personName(person, selfAddress) {
  if (person.address === selfAddress) return 'me';
  return person.name || person.address;
}

// Who a conversation is with, for its row in the list: everyone except the
// signed-in user. Several people are shown by first name, and anyone past the
// third as a count.
export function conversationWith(participants, selfAddress) {
  const others = participants.filter((person) => person.address !== selfAddress);
  if (others.length === 0) return 'me';
  if (others.length === 1) return personName(others[0], selfAddress);

  const short = others.map((person) => (person.name ? person.name.split(/\s+/)[0] : person.address.split('@')[0]));
  return others.length > 3 ? `${short.slice(0, 3).join(', ')} +${others.length - 3}` : short.join(', ');
}

// A file size the way people read one: "812 B", "14 KB", "3.4 MB".
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
