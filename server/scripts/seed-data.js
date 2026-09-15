// The cast. A handful of recurring senders reads more like a real mailbox than
// a thousand strangers would, and it gives the later stages something to work
// with: a thread that actually runs back and forth, a sender whose mail is
// always noise, one who always wants an answer. `kind` separates organisations,
// whose mail is automated, from people, who write back.
export const SENDERS = [
  { name: 'Wolfgang Brandt', address: 'w.brandt@hausverwaltung.example', role: 'landlord', kind: 'person' },
  { name: 'Prüfungsamt', address: 'pruefungsamt@uni.example', role: 'university', kind: 'organisation' },
  { name: 'Studierendensekretariat', address: 'immatrikulation@uni.example', role: 'university', kind: 'organisation' },
  { name: 'Lena Hofmann', address: 'l.hofmann@autowerk.example', role: 'recruiter', kind: 'person' },
  { name: 'Priya Raghavan', address: 'priya.raghavan@techkonzern.example', role: 'recruiter', kind: 'person' },
  { name: 'Stadtbank', address: 'service@stadtbank.example', role: 'bank', kind: 'organisation' },
  { name: 'Krankenkasse', address: 'noreply@krankenkasse.example', role: 'insurance', kind: 'organisation' },
  { name: 'Paketdienst', address: 'sendungsverfolgung@paketdienst.example', role: 'delivery', kind: 'organisation' },
  { name: 'Jonas Weber', address: 'jonas.weber94@mail.example', role: 'friend', kind: 'person' },
  { name: 'Aisha Kamara', address: 'aisha.kamara@uni.example', role: 'classmate', kind: 'person' },
  { name: 'Data Meetup Berlin', address: 'hello@datameetup.example', role: 'newsletter', kind: 'organisation' },
  { name: 'Paper Digest', address: 'digest@paperdigest.example', role: 'newsletter', kind: 'organisation' },
];

// Each template is one thread. `replies` are what comes back after the opener,
// alternating sender and recipient. `intent` is what a human would label the
// thread; stage 6 scores its classifier against it.
export const THREADS = [
  {
    role: 'landlord',
    subject: 'Nebenkostenabrechnung 2025',
    body: 'Sehr geehrter Herr Abid,\n\nanbei die Abrechnung für das vergangene Jahr. Es ergibt sich ein Guthaben von 214,60 EUR zu Ihren Gunsten. Bitte teilen Sie mir Ihre aktuelle Bankverbindung mit, damit ich die Auszahlung anweisen kann.\n\nMit freundlichen Grüßen\nWolfgang Brandt',
    replies: [
      'Guten Tag Herr Brandt,\n\nvielen Dank. Meine Bankverbindung hat sich nicht geändert, es ist weiterhin das Konto bei der Stadtbank.\n\nViele Grüße\nSemab',
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
    body: 'Guten Tag,\n\ndie Anmeldefrist für die Prüfungen des Wintersemesters endet am 15. Januar. Eine Anmeldung nach Fristende ist nur in begründeten Ausnahmefällen möglich.\n\nBitte prüfen Sie Ihre Anmeldungen im Studierendenportal.\n\nPrüfungsamt',
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
    subject: 'Werkstudent Computer Vision (m/w/d) in Berlin',
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
    body: 'Guten Tag,\n\num Ihren studentischen Beitragssatz weiterzuführen, benötigen wir bis zum 31. des Monats eine aktuelle Studienbescheinigung. Ohne diesen Nachweis müssen wir den regulären Beitrag berechnen.\n\nIhre Krankenkasse',
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
    subject: 'Data Meetup Berlin: Call for Proposals schließt bald',
    body: 'The call for proposals for Data Meetup Berlin closes at the end of the month. We are looking for talks on machine learning in production, data engineering and open source tooling.\n\nSubmit a proposal or forward this to someone who should.',
    intent: 'read_only',
  },
  {
    role: 'newsletter',
    subject: 'Weekly digest: 14 new papers in object detection',
    body: 'This week in object detection: three new approaches to open-vocabulary detection, a survey on transformer-based trackers, and updated benchmarks on nuScenes.\n\nUnsubscribe at any time using the link below.',
    intent: 'read_only',
  },
];

// Filler, so the corpus reaches a few thousand messages. Placeholders in braces
// are filled once per thread, so a weekday in the subject is the same weekday
// in every message under it. None of it uses a word from the search
// evaluation, so the filler cannot move the keyword baseline.

// Automated mail from organisations. Nobody answers it: it is read and
// forgotten, or it asks for something to be done by a date. `roles` says who
// may send it, so a classmate never sends a bank statement.
export const NOTIFICATIONS = [
  {
    roles: ['bank'],
    subject: 'Ihr Kontoauszug für {month} ist da',
    body: 'Guten Tag,\n\nIhr Kontoauszug für {month} steht im Online-Banking bereit. Sie finden ihn unter Postfach > Dokumente.\n\nIhre Stadtbank',
    intent: 'read_only',
  },
  {
    roles: ['bank'],
    subject: 'Neuer Login auf Ihrem Konto',
    body: 'Am {date} um {time} Uhr hat sich ein neues Gerät in Ihr Online-Banking eingeloggt. Wenn Sie das waren, müssen Sie nichts tun. Andernfalls sperren Sie bitte umgehend Ihren Zugang.',
    intent: 'read_only',
  },
  {
    roles: ['bank'],
    subject: 'Bitte bestätigen Sie Ihre Anschrift bis {date}',
    body: 'Guten Tag,\n\nim Rahmen der jährlichen Datenprüfung bitten wir Sie, Ihre Anschrift bis zum {date} im Online-Banking zu bestätigen. Danach schränken wir einzelne Funktionen vorübergehend ein.\n\nIhre Stadtbank',
    intent: 'do_at_a_time',
  },
  {
    roles: ['insurance'],
    subject: 'Beitragsanpassung zum Jahreswechsel',
    body: 'Guten Tag,\n\nzum 1. Januar ändert sich der Zusatzbeitrag. Ihr neuer Monatsbeitrag beträgt {amount} EUR. Sie müssen nichts unternehmen.\n\nIhre Krankenkasse',
    intent: 'read_only',
  },
  {
    roles: ['insurance'],
    subject: 'Erinnerung: Vorsorgetermin bis {date} vereinbaren',
    body: 'Guten Tag,\n\nIhr Anspruch auf die jährliche Vorsorgeuntersuchung läuft am {date} ab. Vereinbaren Sie bis dahin einen Termin in einer Praxis Ihrer Wahl.\n\nIhre Krankenkasse',
    intent: 'do_at_a_time',
  },
  {
    roles: ['delivery'],
    subject: 'Ihre Bestellung {n} wurde versandt',
    body: 'Ihre Bestellung {n} ist unterwegs. Die voraussichtliche Zustellung ist am {date}. Den aktuellen Stand sehen Sie in der Sendungsverfolgung.',
    intent: 'read_only',
  },
  {
    roles: ['delivery'],
    subject: 'Abholung in der Filiale bis {date}',
    body: 'Wir konnten Sie leider nicht antreffen. Ihre Sendung {n} liegt bis zum {date} in der Filiale Lindenstraße zur Abholung bereit. Bitte bringen Sie einen Ausweis mit.',
    intent: 'do_at_a_time',
  },
  {
    roles: ['university'],
    subject: 'Vorlesungsunterlagen Woche {n} online',
    body: 'Liebe Studierende,\n\ndie Unterlagen für Woche {n} sind im Lernportal hochgeladen. Die Übungsaufgaben werden in der nächsten Sitzung besprochen.',
    intent: 'read_only',
  },
  {
    roles: ['university'],
    subject: 'Änderung der Öffnungszeiten',
    body: 'Das Büro ist ab dem {date} nur dienstags und donnerstags von 9 bis 12 Uhr geöffnet. Anfragen per E-Mail werden weiterhin bearbeitet.',
    intent: 'read_only',
  },
  {
    roles: ['university'],
    subject: 'Beitrag für das Studienjahr bis {date} zahlen',
    body: 'Guten Tag,\n\nder Beitrag für das kommende Studienjahr muss bis zum {date} eingegangen sein. Nach Ablauf der Frist erfolgt die Exmatrikulation.',
    intent: 'do_at_a_time',
  },
  {
    roles: ['newsletter'],
    subject: 'Meetup am {date}: two talks, pizza included',
    body: 'Hi everyone,\n\nour next meetup is on {date} at {time}. Two talks: one on feature stores, one on testing data pipelines. Seats are limited.\n\nSee you there',
    intent: 'read_only',
  },
  {
    roles: ['newsletter'],
    subject: 'Your weekly reading list',
    body: 'This week: a practical guide to mixed precision training, a comparison of tokenizers for German text, and notes from a talk on evaluating retrieval systems.\n\nManage your subscription at any time.',
    intent: 'read_only',
  },
  {
    roles: ['newsletter'],
    subject: 'Your monthly usage report',
    body: 'Here is your usage for last month: {n} documents indexed and {amount} hours of compute. You are within the free plan.',
    intent: 'read_only',
  },
];

// Exchanges with people. Lines alternate, starting with the other person, and a
// thread uses the first few of them, so a conversation can stop anywhere. Each
// of their lines carries the bucket it earns if it is the latest thing
// received: a question needs a reply, a promise to get back means waiting on
// them, a task with a date is something to do, thanks is just to read.
export const CONVERSATIONS = [
  {
    roles: ['classmate'],
    subject: 'Folien von {weekday}',
    lines: [
      { text: 'Hey, hast du die Folien von {weekday} noch? Ich war krank und habe die Sitzung verpasst.', intent: 'needs_reply' },
      { text: 'Klar, ich lade sie dir gleich in den geteilten Ordner.' },
      { text: 'Danke dir, das rettet mir die Woche!', intent: 'read_only' },
      { text: 'Gern. Sag Bescheid, wenn du bei Aufgabe 3 hängst.' },
      { text: 'Mache ich. Ich schaue es mir am Wochenende an und melde mich dann.', intent: 'waiting_on_them' },
    ],
  },
  {
    roles: ['classmate'],
    subject: 'Lerngruppe am {weekday}',
    lines: [
      { text: 'Wir treffen uns am {weekday} um {time} in der Bibliothek, Raum {n}. Bring bitte deinen Laptop mit.', intent: 'do_at_a_time' },
      { text: 'Passt, ich bin dabei. Soll ich die Übungsblätter ausdrucken?' },
      { text: 'Ja, das wäre super. Druck am besten gleich zwei Exemplare.', intent: 'do_at_a_time' },
      { text: 'Alles klar, bringe ich mit.' },
      { text: 'Top, bis dann!', intent: 'read_only' },
    ],
  },
  {
    roles: ['classmate'],
    subject: 'Projektbericht: wer schreibt was?',
    lines: [
      { text: 'Hi, wir sollten den Bericht aufteilen. Übernimmst du die Auswertung oder lieber die Einleitung?', intent: 'needs_reply' },
      { text: 'Ich nehme die Auswertung, die Plots habe ich ja schon.' },
      { text: 'Gut, dann schreibe ich Einleitung und Methodik und schicke dir meinen Teil bis {weekday}.', intent: 'waiting_on_them' },
      { text: 'Perfekt, dann lese ich ihn gegen.' },
      { text: 'Hier ist mein Teil. Kannst du bis {weekday} drüberschauen?', intent: 'do_at_a_time' },
      { text: 'Mache ich, du hörst morgen von mir.' },
    ],
  },
  {
    roles: ['friend'],
    subject: 'Kino am {weekday}?',
    lines: [
      { text: 'Lust auf Kino am {weekday}? Der neue Film läuft um {time} im Filmtheater am Park.', intent: 'needs_reply' },
      { text: 'Gute Idee, ich bin dabei. Soll ich Karten reservieren?' },
      { text: 'Ja, mach mal, zwei Plätze in der Mitte wären ideal.', intent: 'do_at_a_time' },
      { text: 'Erledigt, Reihe 7. Treffen wir uns vorher auf einen Kaffee?' },
      { text: 'Gerne, ich schreibe dir kurz vorher, wann ich losfahre.', intent: 'waiting_on_them' },
    ],
  },
  {
    roles: ['friend'],
    subject: 'Umzugshelfer gesucht',
    lines: [
      { text: 'Ich ziehe am {date} um. Hättest du vormittags ein paar Stunden Zeit zum Tragen?', intent: 'needs_reply' },
      { text: 'Ja, ich komme. Wann soll ich da sein?' },
      { text: 'Um 9 Uhr. Die Adresse schicke ich dir noch, Pizza gibt es danach!', intent: 'waiting_on_them' },
      { text: 'Klingt gut, ich bringe Handschuhe mit.' },
      { text: 'Hier die Adresse: Lindenallee {n}, dritter Stock. Klingel bei Weber.', intent: 'do_at_a_time' },
    ],
  },
  {
    roles: ['friend'],
    subject: 'Geschenk für Mara',
    lines: [
      { text: 'Mara hat am {date} Geburtstag. Legen wir für ein Geschenk zusammen?', intent: 'needs_reply' },
      { text: 'Ja, gute Idee. Hast du schon was im Kopf?' },
      { text: 'Vielleicht einen Kochkurs. Ich frage die anderen und melde mich.', intent: 'waiting_on_them' },
      { text: 'Super, sag mir dann, wie viel ich überweisen soll.' },
      { text: 'Alle sind dabei, es sind {amount} EUR pro Person. Bitte bis {weekday} überweisen.', intent: 'do_at_a_time' },
    ],
  },
  {
    roles: ['recruiter'],
    subject: 'Rückfrage zu Ihren Unterlagen',
    lines: [
      { text: 'Guten Tag,\n\nkönnten Sie uns noch Ihr aktuelles Notenblatt schicken? Dann kann das Fachteam Ihre Unterlagen vollständig prüfen.', intent: 'needs_reply' },
      { text: 'Guten Tag,\n\ngern, das Notenblatt ist im Anhang.' },
      { text: 'Vielen Dank. Wir melden uns in den nächsten Tagen mit einem Terminvorschlag.', intent: 'waiting_on_them' },
      { text: 'Danke, ich freue mich auf Ihre Nachricht.' },
      { text: 'Hätten Sie am {weekday} um {time} Uhr Zeit für ein Gespräch per Video?', intent: 'needs_reply' },
      { text: 'Ja, der Termin passt mir gut.' },
      { text: 'Schön. Den Link erhalten Sie am Vortag. Bitte halten Sie Ihren Ausweis bereit.', intent: 'do_at_a_time' },
    ],
  },
  {
    roles: ['recruiter'],
    subject: 'Kurzes Update zur Stelle',
    lines: [
      { text: 'Hallo Semab,\n\ndas Team hat sich deine Projekte angesehen und würde gern mehr erfahren. Wann passt dir nächste Woche ein Anruf?', intent: 'needs_reply' },
      { text: 'Hallo, das freut mich! Dienstag oder Mittwoch Nachmittag würde gut passen.' },
      { text: 'Dann Mittwoch um {time}. Ich schicke dir gleich eine Kalendereinladung.', intent: 'do_at_a_time' },
      { text: 'Danke, ist angekommen.' },
      { text: 'Super. Nach dem Anruf melde ich mich mit dem nächsten Schritt.', intent: 'waiting_on_them' },
    ],
  },
  {
    roles: ['landlord'],
    subject: 'Handwerker am {weekday}',
    lines: [
      { text: 'Guten Tag,\n\nam {weekday} zwischen 8 und 12 Uhr kommt der Heizungsmonteur. Bitte sorgen Sie dafür, dass jemand zu Hause ist.', intent: 'do_at_a_time' },
      { text: 'Guten Tag,\n\nich bin da, danke für die Info.' },
      { text: 'Der Monteur hat sich gemeldet, er kommt eine Stunde später. Passt das noch?', intent: 'needs_reply' },
      { text: 'Ja, das ist kein Problem.' },
      { text: 'Danke. Die Heizung sollte danach wieder normal laufen.', intent: 'read_only' },
    ],
  },
  {
    roles: ['landlord'],
    subject: 'Reinigung des Treppenhauses',
    lines: [
      { text: 'Liebe Mieterinnen und Mieter,\n\nab dem {date} übernimmt eine Firma die Reinigung des Treppenhauses. Die Kosten sind in der Miete bereits enthalten.', intent: 'read_only' },
      { text: 'Guten Tag,\n\ngilt das auch für den Keller?' },
      { text: 'Ja, der Keller wird einmal im Monat mitgereinigt. Ich prüfe noch den genauen Termin und gebe Ihnen Bescheid.', intent: 'waiting_on_them' },
    ],
  },
];
