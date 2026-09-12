// The cast. A handful of recurring senders reads more like a real mailbox than
// a thousand strangers would, and it gives the later stages something to work
// with: a thread that actually runs back and forth, a sender whose mail is
// always noise, one who always wants an answer.
export const SENDERS = [
  { name: 'Wolfgang Brandt', address: 'w.brandt@hausverwaltung-cottbus.de', role: 'landlord' },
  { name: 'BTU Prüfungsamt', address: 'pruefungsamt@b-tu.de', role: 'university' },
  { name: 'Studierendensekretariat', address: 'immatrikulation@b-tu.de', role: 'university' },
  { name: 'Lena Hofmann', address: 'l.hofmann@volkswagen-recruiting.de', role: 'recruiter' },
  { name: 'Priya Raghavan', address: 'priya.raghavan@siemens-talent.com', role: 'recruiter' },
  { name: 'Sparkasse Spree-Neiße', address: 'service@sparkasse-spn.de', role: 'bank' },
  { name: 'Techniker Krankenkasse', address: 'noreply@tk.de', role: 'insurance' },
  { name: 'DHL Paket', address: 'sendungsverfolgung@dhl.de', role: 'delivery' },
  { name: 'Jonas Weber', address: 'jonas.weber94@gmail.com', role: 'friend' },
  { name: 'Aisha Kamara', address: 'aisha.kamara@b-tu.de', role: 'classmate' },
  { name: 'PyData Berlin', address: 'hello@pydata-berlin.org', role: 'newsletter' },
  { name: 'Papers With Code', address: 'digest@paperswithcode.com', role: 'newsletter' },
];

// Each template is one thread. `replies` are what comes back after the opener,
// alternating sender and recipient. `needsReply` and `intent` are what a human
// would label the thread; stage 6 scores its classifier against these instead
// of me hand-labelling two hundred messages later.
export const THREADS = [
  {
    role: 'landlord',
    subject: 'Nebenkostenabrechnung 2025',
    body: 'Sehr geehrter Herr Abid,\n\nanbei die Abrechnung für das vergangene Jahr. Es ergibt sich ein Guthaben von 214,60 EUR zu Ihren Gunsten. Bitte teilen Sie mir Ihre aktuelle Bankverbindung mit, damit ich die Auszahlung anweisen kann.\n\nMit freundlichen Grüßen\nWolfgang Brandt',
    replies: [
      'Guten Tag Herr Brandt,\n\nvielen Dank. Meine Bankverbindung hat sich nicht geändert, es ist weiterhin das Konto bei der Sparkasse Spree-Neiße.\n\nViele Grüße\nSemab',
      'Danke für die Rückmeldung. Ich habe die Überweisung veranlasst, das Geld sollte bis Ende des Monats bei Ihnen sein.',
    ],
    intent: 'read_only',
  },
  {
    role: 'landlord',
    // The needle for the semantic search demo. Nowhere in this thread do the
    // words "flat" or "deposit" appear, which is the point: keyword search
    // cannot find it from the phrasing a person would actually type.
    subject: 'Wohnungsübergabe Parkstraße 14',
    body: 'Hallo Herr Abid,\n\nfür die Rückzahlung der Kaution brauche ich noch das Übergabeprotokoll mit Ihrer Unterschrift. Sobald das vorliegt, überweise ich die 1.200 EUR innerhalb von zwei Wochen zurück.\n\nDie Wohnung war in gutem Zustand, es gibt keine Abzüge.\n\nBeste Grüße\nW. Brandt',
    replies: [
      'Guten Tag,\n\ndas unterschriebene Protokoll ist eingescannt im Anhang. Sagen Sie gern, wenn noch etwas fehlt.\n\nSemab',
    ],
    intent: 'waiting_on_them',
  },
  {
    role: 'university',
    subject: 'Anmeldung Prüfung Maschinelles Lernen II',
    body: 'Guten Tag,\n\ndie Anmeldefrist für die Prüfungen des Wintersemesters endet am 15. Januar. Eine Anmeldung nach Fristende ist nur in begründeten Ausnahmefällen möglich.\n\nBitte prüfen Sie Ihre Anmeldungen im Studierendenportal.\n\nPrüfungsamt BTU',
    intent: 'do_at_a_time',
  },
  {
    role: 'university',
    subject: 'Bestätigung der Rückmeldung Sommersemester',
    body: 'Ihre Rückmeldung für das Sommersemester ist eingegangen. Der Semesterbeitrag von 320,50 EUR wurde verbucht. Ihre Immatrikulationsbescheinigung steht im Portal zum Download bereit.',
    intent: 'read_only',
  },
  {
    role: 'recruiter',
    subject: 'Werkstudent Computer Vision (m/w/d) in Wolfsburg',
    body: 'Hallo Semab,\n\nich bin über dein GitHub auf dein KITTI-Projekt gestoßen und war beeindruckt, wie sauber das Tracking dokumentiert ist.\n\nWir suchen gerade einen Werkstudenten für unser Perception-Team, 20 Stunden pro Woche, Start flexibel. Hättest du diese oder nächste Woche 20 Minuten für ein kurzes Gespräch?\n\nViele Grüße\nLena Hofmann',
    intent: 'needs_reply',
  },
  {
    role: 'recruiter',
    subject: 'Re: Ihre Bewerbung, Praktikum Machine Learning',
    body: 'Guten Tag Herr Abid,\n\nvielen Dank für Ihre Bewerbung und Ihre Geduld. Wir haben Ihre Unterlagen an das Fachteam weitergeleitet und melden uns in den kommenden zwei Wochen mit einer Rückmeldung.\n\nMit freundlichen Grüßen\nPriya Raghavan',
    replies: [
      'Guten Tag Frau Raghavan,\n\nvielen Dank für das Update. Ich freue mich auf Ihre Rückmeldung.\n\nBeste Grüße\nSemab Abid',
    ],
    intent: 'waiting_on_them',
  },
  {
    role: 'bank',
    subject: 'Ihre Kreditkarte läuft ab',
    body: 'Sehr geehrte Kundin, sehr geehrter Kunde,\n\nIhre girocard läuft am Ende des Quartals ab. Die neue Karte wird automatisch an Ihre hinterlegte Adresse versandt. Bitte vernichten Sie die alte Karte nach Erhalt.',
    intent: 'read_only',
  },
  {
    role: 'insurance',
    subject: 'Nachweis der Studienbescheinigung erforderlich',
    body: 'Guten Tag,\n\num Ihren studentischen Beitragssatz weiterzuführen, benötigen wir bis zum 31. des Monats eine aktuelle Studienbescheinigung. Ohne diesen Nachweis müssen wir den regulären Beitrag berechnen.\n\nIhre Techniker Krankenkasse',
    intent: 'do_at_a_time',
  },
  {
    role: 'delivery',
    subject: 'Ihre Sendung kommt heute',
    body: 'Ihre Sendung mit der Nummer 00340434161094017299 wird heute zwischen 14:00 und 16:00 Uhr geliefert. Sie können den Zustellzeitraum in der App anpassen.',
    intent: 'read_only',
  },
  {
    role: 'friend',
    subject: 'Wochenende Berlin?',
    body: 'Alter, ich bin am Samstag in Berlin für das Konzert. Hast du Zeit? Könnte auch schon Freitag hochkommen und bei dir pennen, wenn das passt.\n\nSag mal Bescheid, ich muss die Bahn buchen.',
    replies: [
      'Freitag ist gut, ich hab nur bis 16 Uhr Uni. Schlafsack musst du selber mitbringen, mein Sofa ist eine Katastrophe.',
      'Perfekt, ich buche für Freitag Mittag. Bis dann!',
    ],
    intent: 'read_only',
  },
  {
    role: 'classmate',
    subject: 'Gruppenarbeit Statistik, Abgabe Donnerstag',
    body: 'Hey Semab,\n\nich hab den Teil zur Regression fertig, liegt im geteilten Ordner. Kannst du dir den Abschnitt zu den Residuen anschauen? Ich bin nicht sicher, ob die Interpretation stimmt.\n\nAbgabe ist Donnerstag 23:59, also nicht zu knapp.\n\nAisha',
    intent: 'needs_reply',
  },
  {
    role: 'newsletter',
    subject: 'PyData Berlin: Call for Proposals schließt bald',
    body: 'The call for proposals for PyData Berlin closes at the end of the month. We are looking for talks on machine learning in production, data engineering and open source tooling.\n\nSubmit a proposal or forward this to someone who should.',
    intent: 'read_only',
  },
  {
    role: 'newsletter',
    subject: 'Weekly digest: 14 new papers in object detection',
    body: 'This week in object detection: three new approaches to open-vocabulary detection, a survey on transformer-based trackers, and updated benchmarks on nuScenes.\n\nUnsubscribe at any time using the link below.',
    intent: 'read_only',
  },
];

// Filler, so the corpus reaches a few thousand messages without thirteen
// templates repeating in an obvious loop. Deliberately mundane: the interesting
// mail is above, and search needs a haystack to find it in.
export const FILLER_SUBJECTS = [
  'Rechnung {n} verfügbar',
  'Terminerinnerung: {n}. des Monats',
  'Ihre Bestellung {n} wurde versandt',
  'Neuer Login auf Ihrem Konto',
  'Wartungsarbeiten am Wochenende',
  'Vorlesungsunterlagen Woche {n} online',
  'Änderung der Öffnungszeiten',
  'Umfrage: Wie war Ihr Semester?',
  'Beitragsanpassung zum Jahreswechsel',
  'Protokoll der Sitzung vom {n}.',
  'Reminder: room booking {n} expires',
  'Your monthly usage report',
];

// Replies for filler threads. Real mailboxes are mostly one-message threads
// with a minority that actually run back and forth, so these get sampled
// against that distribution rather than applied to everything.
export const FILLER_REPLIES = [
  'Guten Tag,\n\nvielen Dank für die schnelle Rückmeldung. Ich schaue mir das an und melde mich.\n\nViele Grüße\nSemab',
  'Danke, das hat geklappt. Von meiner Seite ist damit alles geklärt.',
  'Hallo,\n\nkönnten Sie mir dazu noch die genaue Frist nennen? Ich möchte nichts verpassen.\n\nBeste Grüße',
  'Die Frist läuft bis zum Ende des Monats. Danach ist eine Bearbeitung nur mit Begründung möglich.',
  'Alles klar, dann warte ich auf Ihre Nachricht. Schönes Wochenende.',
  'Kurze Rückfrage: gilt das auch für Studierende im letzten Semester?',
  'Ja, das gilt unabhängig vom Semester. Bei Fragen gern jederzeit melden.',
];

export const FILLER_BODIES = [
  'Guten Tag,\n\nim Anhang finden Sie die Unterlagen zu Ihrem Vorgang. Bei Rückfragen erreichen Sie uns unter der bekannten Nummer.\n\nMit freundlichen Grüßen',
  'Dies ist eine automatisch generierte Nachricht. Bitte antworten Sie nicht auf diese E-Mail.',
  'Hallo,\n\nkurze Info: der Termin bleibt wie besprochen. Ich melde mich, falls sich etwas ändert.\n\nGrüße',
  'Hi,\n\nthis is a routine notification about your account. No action is required on your side.\n\nThanks',
  'Sehr geehrte Damen und Herren,\n\nwir möchten Sie darüber informieren, dass die Bearbeitung Ihres Anliegens noch andauert. Wir bitten um Ihr Verständnis.\n\nFreundliche Grüße',
];
