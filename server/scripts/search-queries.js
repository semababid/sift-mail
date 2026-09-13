// Questions a person might type, each paired with the subject of the seeded
// conversation that answers it. Stage 2.6 runs them through keyword search;
// stage 5 runs the same set through semantic search, so the two can be
// compared question by question.
//
// The kinds say what each question tests:
//   exact       a word that appears in the mail as written
//   inflected   another grammatical form of such a word
//   compound    part of a German compound word
//   english     the German mail described in English
//   paraphrase  the same idea in German, in different words
export const SEARCH_QUERIES = [
  { kind: 'exact', query: 'Kaution', expect: 'Wohnungsübergabe Parkstraße 14' },
  { kind: 'exact', query: 'Studienbescheinigung', expect: 'Nachweis der Studienbescheinigung erforderlich' },
  { kind: 'exact', query: 'Regression', expect: 'Gruppenarbeit Statistik, Abgabe Donnerstag' },
  { kind: 'exact', query: 'object detection', expect: 'Weekly digest: 14 new papers in object detection' },

  { kind: 'inflected', query: 'Abrechnungen', expect: 'Nebenkostenabrechnung 2025' },
  { kind: 'inflected', query: 'Konzerte', expect: 'Wochenende Berlin?' },
  { kind: 'inflected', query: 'Bewerbungen', expect: 'Re: Ihre Bewerbung, Praktikum Machine Learning' },

  { kind: 'compound', query: 'Nebenkosten', expect: 'Nebenkostenabrechnung 2025' },
  { kind: 'compound', query: 'Übergabe', expect: 'Wohnungsübergabe Parkstraße 14' },
  { kind: 'compound', query: 'Semester', expect: 'Bestätigung der Rückmeldung Sommersemester' },

  { kind: 'english', query: 'flat deposit', expect: 'Wohnungsübergabe Parkstraße 14' },
  { kind: 'english', query: 'service charges bill', expect: 'Nebenkostenabrechnung 2025' },
  { kind: 'english', query: 'exam registration deadline', expect: 'Anmeldung Prüfung Maschinelles Lernen II' },
  { kind: 'english', query: 'health insurance needs my enrolment certificate', expect: 'Nachweis der Studienbescheinigung erforderlich' },
  { kind: 'english', query: 'parcel arrives today', expect: 'Ihre Sendung kommt heute' },

  { kind: 'paraphrase', query: 'Wann bekomme ich mein Geld für die Wohnung zurück', expect: 'Wohnungsübergabe Parkstraße 14' },
  { kind: 'paraphrase', query: 'Paket Lieferung', expect: 'Ihre Sendung kommt heute' },
  { kind: 'paraphrase', query: 'Vorstellungsgespräch Bildverarbeitung', expect: 'Werkstudent Computer Vision (m/w/d) in Berlin' },
];
