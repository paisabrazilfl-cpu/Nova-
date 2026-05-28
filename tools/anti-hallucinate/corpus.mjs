// Deterministic evaluation corpus for the anti-hallucination verifier.
//
// Each FACT yields five cases:
//   - good      : faithful answer (expect ACCEPT)
//   - good2     : faithful paraphrase (expect ACCEPT)
//   - badNum    : right sentence, wrong figure (expect REJECT)
//   - badEnt    : invented named entity (expect REJECT)
//   - badTopic  : on-entity but off-fact claim (expect REJECT)
//
// SPECIALS cover refusals, multi-claim answers, and edge inputs.
// The corpus is static data: no randomness, fully reproducible.

const FACTS = [
  {
    q: "How tall is the Eiffel Tower?",
    ctx: "The Eiffel Tower is a wrought iron lattice tower in Paris. It stands 330 metres tall. It was completed in 1889.",
    good: "The Eiffel Tower stands 330 metres tall.",
    good2: "The tower in Paris is 330 metres tall.",
    badNum: "The Eiffel Tower stands 540 metres tall.",
    badEnt: "The Eiffel Tower was relocated to Glomberg in 1889.",
    badTopic: "The Eiffel Tower is mainly used as a deep sea fishing pier.",
  },
  {
    q: "What is the speed of light in a vacuum?",
    ctx: "Light travels through a vacuum at a constant speed. That speed is 299792458 metres per second. It is a fundamental physical constant.",
    good: "Light travels through a vacuum at 299792458 metres per second.",
    good2: "The constant speed of light in a vacuum is 299792458 metres per second.",
    badNum: "Light travels through a vacuum at 1000000 metres per second.",
    badEnt: "Light travels at a speed measured by the Krellon Bureau.",
    badTopic: "Light in a vacuum slowly dissolves into heavier liquid particles.",
  },
  {
    q: "How high is Mount Everest?",
    ctx: "Mount Everest is Earth's highest mountain above sea level. Its peak rises 8849 metres. It lies on the China Nepal border.",
    good: "Mount Everest rises 8849 metres above sea level.",
    good2: "The peak of Everest reaches 8849 metres.",
    badNum: "Mount Everest rises 4200 metres above sea level.",
    badEnt: "Mount Everest rises above the plains of Tarvonia.",
    badTopic: "Mount Everest is a commercial shipping harbour for cargo vessels.",
  },
  {
    q: "At what temperature does water boil at sea level?",
    ctx: "Water has a well known boiling point. At sea level water boils at 100 degrees Celsius. The value drops at higher altitude.",
    good: "At sea level water boils at 100 degrees Celsius.",
    good2: "Water reaches its boiling point of 100 degrees Celsius at sea level.",
    badNum: "At sea level water boils at 73 degrees Celsius.",
    badEnt: "Water boiling was first measured by the Pemberton Society.",
    badTopic: "Water at sea level turns directly into solid copper crystals.",
  },
  {
    q: "How many bones are in the adult human body?",
    ctx: "The human skeleton changes after birth as bones fuse. An adult human body has 206 bones. Infants are born with around 270.",
    good: "An adult human body has 206 bones.",
    good2: "Adults have 206 bones in the body.",
    badNum: "An adult human body has 320 bones.",
    badEnt: "Adult bone counts were standardized by the Vorhees Council.",
    badTopic: "Adult human bones are primarily used to filter blood sugar.",
  },
  {
    q: "Which is the largest ocean on Earth?",
    ctx: "Earth has five named oceans. The Pacific Ocean is the largest and deepest ocean. It covers about a third of the surface.",
    good: "The Pacific Ocean is the largest and deepest ocean.",
    good2: "The largest and deepest ocean on Earth is the Pacific Ocean.",
    badNum: "The Pacific Ocean is the largest ocean and holds 9 seas.",
    badEnt: "The largest ocean on Earth is the Zelthar Ocean.",
    badTopic: "The Pacific Ocean is a paved highway connecting two cities.",
  },
  {
    q: "What process do plants use to make food?",
    ctx: "Plants are autotrophs. Photosynthesis lets plants convert sunlight into chemical energy. The process releases oxygen.",
    good: "Photosynthesis lets plants convert sunlight into chemical energy.",
    good2: "Plants convert sunlight into chemical energy through photosynthesis.",
    badNum: "Photosynthesis lets plants convert sunlight in 12 distinct stages.",
    badEnt: "Plants make food using a method named Brixonation.",
    badTopic: "Photosynthesis lets plants walk slowly toward warmer soil.",
  },
  {
    q: "What does DNA store?",
    ctx: "DNA is found in living cells. DNA stores the genetic instructions of an organism. It is shaped as a double helix.",
    good: "DNA stores the genetic instructions of an organism.",
    good2: "The genetic instructions of an organism are stored in DNA.",
    badNum: "DNA stores the genetic instructions across 88 separate disks.",
    badEnt: "Genetic instructions are stored in a molecule called Quorlite.",
    badTopic: "DNA stores rainfall data for regional weather forecasts.",
  },
  {
    q: "What does an HTTP 404 status code mean?",
    ctx: "HTTP defines numeric status codes. A 404 status code means the requested resource was not found. It is a client error.",
    good: "A 404 status code means the requested resource was not found.",
    good2: "HTTP 404 indicates the requested resource was not found.",
    badNum: "A 404 status code means the request timed out after 30 seconds.",
    badEnt: "The 404 status code was defined by the Hollux Standard.",
    badTopic: "A 404 status code means the server has been physically relocated.",
  },
  {
    q: "What is the Python programming language known for?",
    ctx: "Python is a high level programming language. Python is known for readable syntax and broad library support. It was first released in 1991.",
    good: "Python is known for readable syntax and broad library support.",
    good2: "Python is recognized for its readable syntax and broad libraries.",
    badNum: "Python is known for readable syntax across 7 mandatory dialects.",
    badEnt: "Python was first released by the Trantor Foundation.",
    badTopic: "Python is known for grinding metal parts in heavy factories.",
  },
  {
    q: "What is the function of mitochondria?",
    ctx: "Mitochondria are organelles inside cells. Mitochondria generate most of the cell's chemical energy. They are often called the powerhouse of the cell.",
    good: "Mitochondria generate most of the cell's chemical energy.",
    good2: "Most of a cell's chemical energy is generated by mitochondria.",
    badNum: "Mitochondria generate most of the cell's energy using 5 nuclei.",
    badEnt: "Cellular energy is generated by structures named Florbosomes.",
    badTopic: "Mitochondria generate printed currency for the central bank.",
  },
  {
    q: "What is the Great Wall of China?",
    ctx: "The Great Wall of China is a series of fortifications. The Great Wall was built to protect Chinese states from invasions. It stretches thousands of kilometres.",
    good: "The Great Wall was built to protect Chinese states from invasions.",
    good2: "The Great Wall of China was built to protect Chinese states from invasion.",
    badNum: "The Great Wall was built to protect exactly 14 Chinese cities.",
    badEnt: "The Great Wall was built to protect the kingdom of Velmoria.",
    badTopic: "The Great Wall of China is a floating bridge for aircraft.",
  },
  {
    q: "What does the Git version control system do?",
    ctx: "Git is a distributed version control system. Git tracks changes to source code over time. It lets many developers collaborate.",
    good: "Git tracks changes to source code over time.",
    good2: "Git records changes to source code over time.",
    badNum: "Git tracks changes to source code for up to 3 users only.",
    badEnt: "Source code changes are tracked by a system called Grindle.",
    badTopic: "Git tracks the migration patterns of ocean birds.",
  },
  {
    q: "What is TCP used for?",
    ctx: "TCP is a core internet protocol. TCP provides reliable ordered delivery of data between computers. It works alongside IP.",
    good: "TCP provides reliable ordered delivery of data between computers.",
    good2: "TCP delivers data reliably and in order between computers.",
    badNum: "TCP provides reliable delivery of data across 64 fixed lanes.",
    badEnt: "Reliable delivery between computers is provided by Zinprotocol.",
    badTopic: "TCP provides fresh drinking water to remote villages.",
  },
  {
    q: "What is RAM in a computer?",
    ctx: "A computer has several kinds of memory. RAM is fast volatile memory used to hold running programs and data. Its contents are lost on power off.",
    good: "RAM is fast volatile memory used to hold running programs and data.",
    good2: "RAM is fast volatile memory that holds running programs and data.",
    badNum: "RAM is fast volatile memory rated for 99 years of retention.",
    badEnt: "Running programs are held in a chip called the Quibble core.",
    badTopic: "RAM is a cooling liquid poured over the processor.",
  },
  {
    q: "Where is the Mariana Trench?",
    ctx: "The Mariana Trench is the deepest known part of the ocean. The Mariana Trench is located in the western Pacific Ocean. Its depth exceeds 10000 metres.",
    good: "The Mariana Trench is located in the western Pacific Ocean.",
    good2: "The Mariana Trench lies in the western Pacific Ocean.",
    badNum: "The Mariana Trench is located 250 metres inland from the coast.",
    badEnt: "The Mariana Trench is located within the Borealis Sea.",
    badTopic: "The Mariana Trench is a busy airport for passenger jets.",
  },
  {
    q: "What do honey bees produce?",
    ctx: "Honey bees live in organized colonies. Honey bees produce honey from flower nectar. They also pollinate many crops.",
    good: "Honey bees produce honey from flower nectar.",
    good2: "Honey is produced by honey bees from flower nectar.",
    badNum: "Honey bees produce honey from nectar in 40 sealed vaults.",
    badEnt: "Honey is produced by insects called the Grendl swarm.",
    badTopic: "Honey bees produce structural steel for tall buildings.",
  },
  {
    q: "What is Saturn known for?",
    ctx: "Saturn is the sixth planet from the Sun. Saturn is known for its prominent ring system. The rings are made mostly of ice particles.",
    good: "Saturn is known for its prominent ring system.",
    good2: "Saturn is recognized for its prominent ring system.",
    badNum: "Saturn is known for its prominent system of 9 solid rings.",
    badEnt: "The ringed planet in this account is named Drovax.",
    badTopic: "Saturn is known for hosting the largest desert on Earth.",
  },
  {
    q: "What do antibiotics treat?",
    ctx: "Antibiotics are a class of medicine. Antibiotics treat infections caused by bacteria. They are not effective against viruses.",
    good: "Antibiotics treat infections caused by bacteria.",
    good2: "Bacterial infections are treated with antibiotics.",
    badNum: "Antibiotics treat bacterial infections within 2 minutes.",
    badEnt: "Bacterial infections are treated with a drug called Velcomycin.",
    badTopic: "Antibiotics treat cracked windshields on parked cars.",
  },
  {
    q: "What is the Linux kernel?",
    ctx: "Linux is a family of operating systems. The Linux kernel is the core component that manages hardware and processes. It was first released in 1991.",
    good: "The Linux kernel is the core component that manages hardware and processes.",
    good2: "The Linux kernel manages hardware and processes as the core component.",
    badNum: "The Linux kernel manages hardware across exactly 16 layers.",
    badEnt: "The operating system core here is the Norbix kernel.",
    badTopic: "The Linux kernel is the core component that bakes fresh bread.",
  },
  {
    q: "What is JSON used for?",
    ctx: "JSON is a lightweight data format. JSON is used to exchange structured data between systems. It is based on text.",
    good: "JSON is used to exchange structured data between systems.",
    good2: "Structured data is exchanged between systems using JSON.",
    badNum: "JSON is used to exchange structured data over 11 binary ports.",
    badEnt: "Structured data is exchanged using a format called Yamlite.",
    badTopic: "JSON is used to generate electrical power for households.",
  },
  {
    q: "How long is the Amazon River roughly?",
    ctx: "The Amazon River flows through South America. The Amazon River is about 6400 kilometres long. It carries more water than any other river.",
    good: "The Amazon River is about 6400 kilometres long.",
    good2: "The Amazon River is roughly 6400 kilometres long.",
    badNum: "The Amazon River is about 900 kilometres long.",
    badEnt: "The long river described here is the Quenmar River.",
    badTopic: "The Amazon River is a sealed underground subway tunnel.",
  },
  {
    q: "What is the Sun mostly made of?",
    ctx: "The Sun is a star at the centre of the solar system. The Sun is composed mostly of hydrogen and helium. It produces energy by nuclear fusion.",
    good: "The Sun is composed mostly of hydrogen and helium.",
    good2: "The Sun consists mostly of hydrogen and helium.",
    badNum: "The Sun is composed mostly of hydrogen across 3 thin shells.",
    badEnt: "The central star described here is named Pyrothar.",
    badTopic: "The Sun is composed mostly of compressed office paper.",
  },
  {
    q: "What does the spreadsheet feature autosum do?",
    ctx: "Spreadsheets offer many built in features. The autosum feature adds up the numbers in a selected range. It saves manual entry.",
    good: "The autosum feature adds up the numbers in a selected range.",
    good2: "Autosum totals the numbers within a selected range.",
    badNum: "The autosum feature adds up numbers in 5 ranges only.",
    badEnt: "Adding numbers in a range is done by a feature called Tallyx.",
    badTopic: "The autosum feature repaints the walls of the office.",
  },
];

function buildFromFacts() {
  const cases = [];
  let n = 0;
  for (const f of FACTS) {
    n += 1;
    const base = "F" + String(n).padStart(2, "0");
    cases.push({
      id: base + "-good",
      kind: "grounded",
      question: f.q,
      context: f.ctx,
      answer: f.good,
      expect: "ACCEPT",
    });
    cases.push({
      id: base + "-good2",
      kind: "grounded",
      question: f.q,
      context: f.ctx,
      answer: f.good2,
      expect: "ACCEPT",
    });
    cases.push({
      id: base + "-badNum",
      kind: "hallucinated",
      question: f.q,
      context: f.ctx,
      answer: f.badNum,
      expect: "REJECT",
    });
    cases.push({
      id: base + "-badEnt",
      kind: "hallucinated",
      question: f.q,
      context: f.ctx,
      answer: f.badEnt,
      expect: "REJECT",
    });
    cases.push({
      id: base + "-badTopic",
      kind: "hallucinated",
      question: f.q,
      context: f.ctx,
      answer: f.badTopic,
      expect: "REJECT",
    });
  }
  return cases;
}

const SPECIALS = [
  {
    id: "S01-refusal-correct",
    kind: "refusal",
    question: "What is the population of the capital city?",
    context:
      "The report covers annual rainfall in three river basins. It does not mention any city populations.",
    answer: "I don't know; the context does not provide that information.",
    expect: "REFUSAL",
  },
  {
    id: "S02-refusal-no-data",
    kind: "refusal",
    question: "Who won the 2031 championship?",
    context: "This document lists safety procedures for laboratory equipment.",
    answer: "No verifiable answer found in the provided context.",
    expect: "REFUSAL",
  },
  {
    id: "S03-multi-claim-grounded",
    kind: "grounded",
    question: "Tell me about the Pacific Ocean.",
    context:
      "The Pacific Ocean is the largest ocean on Earth. The Pacific Ocean is also the deepest ocean.",
    answer:
      "The Pacific Ocean is the largest ocean on Earth. The Pacific Ocean is also the deepest ocean.",
    expect: "ACCEPT",
  },
  {
    id: "S04-multi-claim-one-bad",
    kind: "hallucinated",
    question: "Tell me about the Pacific Ocean.",
    context: "The Pacific Ocean is the largest ocean on Earth. It contains many islands.",
    answer:
      "The Pacific Ocean is the largest ocean on Earth. The Pacific Ocean was drained completely in 1950.",
    expect: "REJECT",
  },
  {
    id: "S05-fabricated-citation",
    kind: "hallucinated",
    question: "What does the study conclude?",
    context: "The study measured soil moisture at four test plots over one season.",
    answer:
      "The study concludes that soil moisture rose 47 percent according to the Hartwell Index.",
    expect: "REJECT",
  },
  {
    id: "S06-empty-answer",
    kind: "hallucinated",
    question: "What is the result?",
    context: "The pipeline produced a numeric result during the last run.",
    answer: "   ",
    expect: "REJECT",
  },
  {
    id: "S07-grounded-verbatim",
    kind: "grounded",
    question: "What colour is the sample?",
    context:
      "The laboratory sample was tested twice. The sample is bright green under normal light.",
    answer: "The sample is bright green under normal light.",
    expect: "ACCEPT",
  },
  {
    id: "S08-off-domain-question",
    kind: "refusal",
    question: "What is the capital of Mars?",
    context: "Mars is the fourth planet from the Sun. It has two small moons.",
    answer: "I do not know the capital of Mars from this context.",
    expect: "REFUSAL",
  },
  {
    id: "S09-number-swap-subtle",
    kind: "hallucinated",
    question: "How many test plots were used?",
    context: "The study measured soil moisture at four test plots. Each plot was checked weekly.",
    answer: "The study measured soil moisture at 9 test plots.",
    expect: "REJECT",
  },
  {
    id: "S10-grounded-paraphrase",
    kind: "grounded",
    question: "How often was each plot checked?",
    context: "The study measured soil moisture at four test plots. Each plot was checked weekly.",
    answer: "Each test plot was checked weekly.",
    expect: "ACCEPT",
  },
];

export const CASES = [...buildFromFacts(), ...SPECIALS];
