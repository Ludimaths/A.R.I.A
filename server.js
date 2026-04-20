
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DEFAULT_INITIAL_CREDITS = 300;
const SESSION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const PROGRAM_CONFIG = {
  cap: {
    label: "CAP",
    tone: "simple, concret, très guidé",
    chapitres: {
      "Calculs numériques": "Priorité aux automatismes, au calcul et à l'explication simple des étapes.",
      "Calculs commerciaux et financiers": "Travail sur pourcentages, remises, TVA, coefficients multiplicateurs, intérêts simples.",
      "Algèbre – Analyse": "Expressions littérales, équations simples, proportionnalité, lecture de graphiques.",
      "Statistiques – Probabilités": "Lecture, calcul et interprétation d'indicateurs simples.",
      "Géométrie": "Mesures, conversions, figures usuelles, grandeurs, schémas.",
      "Algorithmique et programmation": "Décomposition de problèmes, séquences d’instructions, variables, boucles et logique pas à pas."
    }
  },
  seconde: {
    label: "Seconde Bac Pro",
    tone: "simple, clair, progressif",
    chapitres: {
      "Automatismes": "Consolider les bases, calculs, conversions et procédures courantes.",
      "Algèbre – Analyse": "Expressions, équations, fonctions, lecture et interprétation de représentations.",
      "Statistiques – Probabilités": "Organisation et lecture de données, fréquences, indicateurs.",
      "Géométrie": "Repérage, propriétés, mesures, configurations usuelles.",
      "Algorithmique et programmation": "Décomposition de problèmes, Python, logique, simulation simple."
    }
  },
  premiere: {
    label: "Première Bac Pro",
    tone: "guidé mais plus autonome",
    chapitres: {
      "Automatismes": "Consolider les méthodes de calcul et les procédures essentielles.",
      "Algèbre – Analyse": "Fonctions, variations, équations, outils algébriques adaptés au niveau.",
      "Statistiques – Probabilités": "Indicateurs, lecture critique, interprétation de situations.",
      "Géométrie": "Configurations, grandeurs, raisonnement géométrique.",
      "Algorithmique": "Enchaînements logiques, simulation, traitement de données.",
      "Vocabulaire ensembliste et logique": "Langage mathématique, conditions, implications, ensembles."
    }
  },
  terminale: {
    label: "Terminale Bac Pro",
    tone: "sobre, précis, orienté méthode",
    chapitres: {
      "Automatismes": "Consolidation rapide des procédures et méthodes utiles.",
      "Algèbre – Analyse": "Fonctions, dérivation, variations, lecture graphique, interprétation dans un contexte.",
      "Statistiques – Probabilités": "Lecture, modélisation simple, prise de décision à partir de données.",
      "Géométrie": "Repérage, grandeurs, configurations et interprétation de résultats.",
      "Algorithmique": "Logique de traitement, simulation, lecture d'algorithmes.",
      "Vocabulaire ensembliste et logique": "Utilisation du langage logique pour structurer un raisonnement."
    }
  }
};

const MODES = {
  decouverte: { label: "Découverte", showScoreDetails: false },
  guide: { label: "Guidé", showScoreDetails: true },
  analyse: { label: "Analyse", showScoreDetails: true }
};

const sessionsStore = new Map();
const participantsStore = new Map();
const analysesStore = [];
const assessmentsStore = [];

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function sanitizeText(value = "", maxLen = 8000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maxLen);
}

function sanitizeArray(values, maxItems = 30, maxLen = 250) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => sanitizeText(v, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function createSessionCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += SESSION_CODE_ALPHABET[Math.floor(Math.random() * SESSION_CODE_ALPHABET.length)];
  }
  return code;
}

function flattenProgramText(value) {
  if (value == null) return [];
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenProgramText(item));
  }
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([key, val]) => {
      if (["domain_key", "chapter_key", "label", "groupements", "context_examples_by_groupement"].includes(key)) {
        return [];
      }
      return flattenProgramText(val);
    });
  }
  return [];
}

function dedupeStrings(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeText(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitCapacityLine(line = "") {
  const text = sanitizeText(line, 3000);
  return text ? [text] : [];
}

function normalizeCapacityArray(items = []) {
  return dedupeStrings(items.flatMap((item) => splitCapacityLine(item)));
}

function parseJsonChunk(raw, startIdx = 0) {
  try {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let started = false;
    for (let i = startIdx; i < raw.length; i += 1) {
      const ch = raw[i];
      if (!started) {
        if (/\s/.test(ch)) continue;
        if (ch !== '{' && ch !== '[') return null;
        started = true;
        depth = 1;
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{' || ch === '[') depth += 1;
      if (ch === '}' || ch === ']') depth -= 1;
      if (depth === 0) {
        return { value: JSON.parse(raw.slice(startIdx, i + 1)), end: i + 1 };
      }
    }
  } catch (_e) {
    return null;
  }
  return null;
}

function readFirstExistingJson(candidatePaths = []) {
  for (const filePath of candidatePaths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, "utf8");
      try {
        return JSON.parse(raw);
      } catch (_error) {
        const objects = [];
        let idx = 0;
        while (idx < raw.length) {
          while (idx < raw.length && /\s/.test(raw[idx])) idx += 1;
          if (idx >= raw.length) break;
          const parsed = parseJsonChunk(raw, idx);
          if (!parsed) break;
          objects.push(parsed.value);
          idx = parsed.end;
        }
        if (objects.length === 1) return objects[0];
        if (objects.length > 1) return objects;
        throw new Error("JSON illisible");
      }
    } catch (error) {
      console.error("Erreur lecture programme :", filePath, error.message);
    }
  }
  return null;
}

function uniqueStrings(items = []) {
  return dedupeStrings((items || []).map((x) => sanitizeText(x, 3000)).filter(Boolean));
}

function canonicalGroups(groupements = [], specificCondition = "") {
  const cond = normalizeText(specificCondition);

  if (
    cond.includes("ne comportant pas d'enseignement de physique-chimie") ||
    cond.includes("ne comportant pas d’enseignement de physique-chimie") ||
    cond.includes("ne suivant pas l'enseignement de physique-chimie") ||
    cond.includes("ne suivant pas l’enseignement de physique-chimie")
  ) {
    return ["SANS_SCIENCE"];
  }

  return [...new Set(
    sanitizeArray(groupements || [], 10, 40)
      .map((g) => sanitizeText(g, 40).toUpperCase())
      .filter(Boolean)
  )];
}

function isVocabDomain(source = {}) {
  const key = normalizeText(source?.domain_key || source?.chapter_key || "");
  const label = normalizeText(source?.domain_label || source?.label || "");
  return key.includes("vocabulaire") || key.includes("logique") || label.includes("vocabulaire") || label.includes("logique");
}

function extractCapacities(source = {}) {
  const official = source?.official_program || {};
  const itemLabels = Array.isArray(source?.items)
    ? source.items.map((item) => sanitizeText(item?.ui_label || item?.label || item?.name || item?.key || "", 300)).filter(Boolean)
    : [];
  const base = normalizeCapacityArray([
    ...flattenProgramText(source?.capacities),
    ...flattenProgramText(source?.capacities_exact),
    ...flattenProgramText(official?.capacities_exact),
    ...flattenProgramText(official?.automatismes_list_exact),
    ...flattenProgramText(official?.specific_lists_exact),
    ...flattenProgramText(source?.automatismes_after_treatment),
    ...itemLabels,
  ]);
  if (base.length) return base;
  if (isVocabDomain(source)) {
    return normalizeCapacityArray([
      ...flattenProgramText(official?.knowledge_exact),
      ...flattenProgramText(official?.logic_exact),
      ...flattenProgramText(official?.specific_points_exact),
    ]);
  }
  return base;
}

function extractKnowledge(source = {}) {
  const official = source?.official_program || {};
  const itemTexts = Array.isArray(source?.items)
    ? source.items.flatMap((item) => [item?.official_text, ...(item?.memory_aids || [])].filter(Boolean))
    : [];
  return uniqueStrings([
    ...flattenProgramText(source?.knowledge),
    ...flattenProgramText(source?.knowledge_exact),
    ...flattenProgramText(official?.knowledge_exact),
    ...flattenProgramText(official?.comments_exact),
    ...flattenProgramText(source?.comments),
    ...flattenProgramText(source?.comments_exact),
    ...itemTexts,
  ]);
}

function buildChapterConfig(level, chapter = {}, fallbackGroups = [], fallbackSpecificCondition = "") {
  const capacities = extractCapacities(chapter);
  const knowledge = extractKnowledge(chapter);

  const ownGroups = canonicalGroups(chapter?.groupements || [], chapter?.specific_condition || "");
  const fallback = canonicalGroups(fallbackGroups, fallbackSpecificCondition);

  let groupements = ownGroups.length ? ownGroups : fallback;

  const chapterLabelNorm = normalizeText(chapter?.label || chapter?.name || chapter?.chapter_key || "");

  // Règles métier uniquement pour la terminale
  if (level === "terminale") {
    if (chapterLabelNorm.includes("vecteur")) {
      groupements = ["B"];
    } else if (chapterLabelNorm.includes("trigonom")) {
      groupements = ["A"];
    }
  }

  // Cas "sans science" sur calculs commerciaux et financiers
  if (
    chapterLabelNorm.includes("calculs commerciaux") ||
    chapterLabelNorm.includes("commerciaux et financiers")
  ) {
    const cond = normalizeText(chapter?.specific_condition || fallbackSpecificCondition || "");
    if (
      cond.includes("ne comportant pas d'enseignement de physique-chimie") ||
      cond.includes("ne comportant pas d’enseignement de physique-chimie") ||
      cond.includes("ne suivant pas l'enseignement de physique-chimie") ||
      cond.includes("ne suivant pas l’enseignement de physique-chimie")
    ) {
      groupements = ["SANS_SCIENCE"];
    }
  }

  return { capacities, knowledge, groupements };
}

function ensureDomain(normalized, domainLabel) {
  if (!normalized.domains[domainLabel]) {
    normalized.domains[domainLabel] = { chapters: {}, automatismes: [], groupements: [] };
  }
  return normalized.domains[domainLabel];
}

function mergeDomainConfig(target, incoming) {
  if (!incoming) return target;
  target.groupements = uniqueStrings([...(target.groupements || []), ...(incoming.groupements || [])]);
  if (incoming.automatismes?.length) {
    target.automatismes = uniqueStrings([...(target.automatismes || []), ...incoming.automatismes]);
  }
  for (const [chapterLabel, cfg] of Object.entries(incoming.chapters || {})) {
    if (!target.chapters[chapterLabel]) {
      target.chapters[chapterLabel] = cfg;
    } else {
      target.chapters[chapterLabel] = {
        capacities: uniqueStrings([...(target.chapters[chapterLabel].capacities || []), ...(cfg.capacities || [])]),
        knowledge: uniqueStrings([...(target.chapters[chapterLabel].knowledge || []), ...(cfg.knowledge || [])]),
        groupements: uniqueStrings([...(target.chapters[chapterLabel].groupements || []), ...(cfg.groupements || [])]),
      };
    }
  }
  return target;
}

function buildDomainConfig(level, domain = {}) {
  const domainLabel = sanitizeText(domain?.domain_label || domain?.label || "", 300);
  const domainGroups = canonicalGroups(domain?.groupements || [], domain?.specific_condition || "");
  const out = { chapters: {}, automatismes: [], groupements: domainGroups };

  if (normalizeText(domainLabel) === "automatismes") {
    out.automatismes = extractCapacities(domain);
  }

  if (Array.isArray(domain?.chapters) && domain.chapters.length) {
    for (const chapter of domain.chapters) {
      const chapterLabel = sanitizeText(chapter?.label || chapter?.name || chapter?.chapter_key || "", 300);
      if (!chapterLabel) continue;
      const cfg = buildChapterConfig(level, chapter, domainGroups, domain?.specific_condition || "");
      out.chapters[chapterLabel] = cfg;
      if (normalizeText(domainLabel) === "automatismes") {
        out.automatismes = uniqueStrings([...out.automatismes, ...cfg.capacities]);
      }
    }
  } else if (Array.isArray(domain?.items) && domain.items.length) {
    out.chapters[domainLabel] = buildChapterConfig(level, domain, domainGroups, domain?.specific_condition || "");
  } else if (domain?.official_program || domain?.capacities || domain?.knowledge) {
    out.chapters[domainLabel] = buildChapterConfig(level, domain, domainGroups, domain?.specific_condition || "");
  }

  if (normalizeText(domainLabel) === "automatismes" && !out.automatismes.length) {
    out.automatismes = uniqueStrings(Object.values(out.chapters).flatMap((c) => c.capacities || []));
  }

  return { domainLabel, config: out };
}

function addDomain(level, normalized, domainObj) {
  const { domainLabel, config } = buildDomainConfig(level, domainObj);
  if (!domainLabel) return;
  mergeDomainConfig(ensureDomain(normalized, domainLabel), config);
}

function normalizeSecondeProgram(rawList) {
  const normalized = { label: "Seconde Bac Pro", domains: {} };
  const mapping = {
    statistique_une_variable: "Statistique et probabilités",
    fluctuation_frequence_probabilites: "Statistique et probabilités",
    resolution_premier_degre: "Algèbre – Analyse",
    fonctions: "Algèbre – Analyse",
    calculs_commerciaux_financiers: "Algèbre – Analyse",
    geometrie: "Géométrie",
    algorithmique_programmation: "Algorithmique et programmation",
  };
  for (const obj of rawList || []) {
    if (obj?.chapter_key && mapping[obj.chapter_key]) {
      addDomain("seconde", normalized, { domain_label: mapping[obj.chapter_key], chapters: [obj] });
    } else if (obj?.domain_key === "automatismes") {
      addDomain("seconde", normalized, { domain_label: "Automatismes", chapters: [{ ...obj, chapter_key: "automatismes", label: "Automatismes" }] });
   } else if (obj?.domain_key === "vocabulaire_logique") {
  addDomain("seconde", normalized, { ...obj, domain_label: "Vocabulaire ensembliste et logique" });
}
  }
  return normalized;
}

function normalizeListBasedProgram(rawList, levelLabel) {
  const normalized = { label: levelLabel, domains: {} };
  for (const obj of rawList || []) {
    if (obj?.modules_transversaux) {
     for (const domain of obj.modules_transversaux || []) addDomain(levelLabel === "CAP" ? "cap" : "premiere", normalized, { ...domain, domain_label: domain.domain_label || domain.label });
      if (obj?.vocabulaire_logique) addDomain(levelLabel === "CAP" ? "cap" : "premiere", normalized, { ...obj.vocabulaire_logique, domain_label: "Vocabulaire ensembliste et logique" });
    } else {
      addDomain(levelLabel === "CAP" ? "cap" : "premiere", normalized, { ...obj, domain_label: obj.domain_label || obj.label });
    }
  }
  return normalized;
}

function normalizeTerminaleProgram(rawProgram) {
  const normalized = { label: sanitizeText(rawProgram?.label || "Terminale Bac Pro", 200), domains: {} };

  if (rawProgram?.domain_key || rawProgram?.domain_label) {
    addDomain("terminale", normalized, {
      ...rawProgram,
      domain_label: rawProgram.domain_label || rawProgram.label
    });
  }

  for (const domain of rawProgram?.domains || []) {
    if (domain?.domain_key === "statistiques" || domain?.domain_key === "probabilites") {
      addDomain("terminale", normalized, {
        ...domain,
        domain_label: "Statistique et probabilités"
      });
    } else if (domain?.domain_key === "geometrie") {
      addDomain("terminale", normalized, {
        ...domain,
        domain_label: "Géométrie",
        groupements: ["B"]
      });
    } else if (domain?.domain_key === "geometrie_trig") {
      addDomain("terminale", normalized, {
        ...domain,
        domain_label: "Géométrie",
        groupements: ["A"]
      });
    } else {
      addDomain("terminale", normalized, {
        ...domain,
        domain_label: domain.label || domain.domain_label
      });
    }
  }

  if (rawProgram?.vocabulaire_logique) {
    addDomain("terminale", normalized, {
      ...rawProgram.vocabulaire_logique,
      domain_label: "Vocabulaire ensembliste et logique"
    });
  }

  if (rawProgram?.programme_complementaire) {
    const pc = {
      ...rawProgram.programme_complementaire,
      domain_label:
        rawProgram.programme_complementaire.label ||
        "Programme complémentaire – poursuite d’études"
    };

    pc.chapters = (pc.chapters || []).map((chapter, index) => ({
      chapter_key:
        chapter.chapter_key ||
        sanitizeText(chapter.name || `module_${index + 1}`, 120)
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, ""),
      label: chapter.label || chapter.name || `Module ${index + 1}`,
      capacities: chapter.capacities || chapter.capacities_exact || [],
      knowledge: chapter.knowledge || chapter.knowledge_exact || [],
      comments: chapter.comments || chapter.comments_exact || [],
      groupements: chapter.groupements || [],
      specific_condition: chapter.specific_condition || pc.specific_condition || "",
    }));

    addDomain("terminale", normalized, pc);
  }

  return normalized;
}

function orderDomains(level, domains) {
  const order = {
    cap: ["Statistique – Probabilités", "Algèbre – Analyse", "Calculs commerciaux et financiers", "Géométrie", "Calculs numériques", "Algorithmique et programmation", "Automatismes"],
    seconde: ["Statistique et probabilités", "Algèbre – Analyse", "Géométrie", "Algorithmique et programmation", "Automatismes", "Vocabulaire ensembliste et logique"],
    premiere: ["Statistique et probabilités", "Algèbre – Analyse", "Géométrie", "Algorithmique et programmation", "Automatismes", "Vocabulaire ensembliste et logique"],
    terminale: ["Statistique et probabilités", "Algèbre – Analyse", "Géométrie", "Algorithmique et programmation", "Automatismes", "Vocabulaire ensembliste et logique", "Programme complémentaire – poursuite d’études"],
  }[level] || [];
  const ordered = {};
  for (const label of order) if (domains[label]) ordered[label] = domains[label];
  for (const [label, cfg] of Object.entries(domains)) if (!ordered[label]) ordered[label] = cfg;
  return ordered;
}

function normalizeRawProgram(level, rawProgram) {
  if (!rawProgram) return { label: level, domains: {} };
  let normalized;
  if (level === "seconde" && Array.isArray(rawProgram)) normalized = normalizeSecondeProgram(rawProgram);
  else if ((level === "cap" || level === "premiere") && Array.isArray(rawProgram)) normalized = normalizeListBasedProgram(rawProgram, level === "cap" ? "CAP" : "Première Bac Pro");
  else if (level === "terminale") normalized = normalizeTerminaleProgram(rawProgram);
  else if (rawProgram?.domains) {
    normalized = { label: sanitizeText(rawProgram.label || level, 200), domains: {} };
   for (const domain of rawProgram.domains || []) addDomain(level, normalized, domain);
  } else {
    normalized = { label: sanitizeText(rawProgram.label || level, 200), domains: {} };
  }
  normalized.domains = orderDomains(level, normalized.domains || {});
  return normalized;
}

function buildMathsReference() {
  const dataDir = path.join(__dirname, "data");
  const perLevelFiles = {
    cap: [path.join(dataDir, "programme_CAP.json"), path.join(dataDir, "programme_cap.json"), path.join(__dirname, "programme_CAP.json"), path.join(__dirname, "programme_cap.json")],
    seconde: [path.join(dataDir, "programme_seconde.json"), path.join(__dirname, "programme_seconde.json")],
    premiere: [path.join(dataDir, "programme_premiere.json"), path.join(dataDir, "programme_première.json"), path.join(__dirname, "programme_premiere.json"), path.join(__dirname, "programme_première.json")],
    terminale: [path.join(dataDir, "programme_terminale.json"), path.join(__dirname, "programme_terminale.json")],
  };
  const built = {};
  for (const [level, candidates] of Object.entries(perLevelFiles)) {
    const raw = readFirstExistingJson(candidates);
    built[level] = normalizeRawProgram(level, raw);
  }
  return built;
}

const MATHS_REFERENCE = buildMathsReference();

app.get("/api/programme-reference", (_req, res) => {
  try {
    res.json(buildMathsReference());
  } catch (error) {
    console.error("Référentiel introuvable :", error.message);
    res.status(500).json({ error: "Référentiel introuvable." });
  }
});

const NOTION_RULES = {
  "pourcentages": {
    "keywords": [
      "pourcentage",
      "pourcentages",
      "coefficient multiplicateur",
      "remise",
      "rabais",
      "ristourne",
      "taux",
      "échelle"
    ],
    "guidance": [
      "Toujours passer par 100% + variation avant de convertir en coefficient multiplicateur.",
      "Corriger explicitement l’erreur 10% = 0,1 comme raison d’augmentation : une hausse de 10% correspond à ×1,10.",
      "Utiliser l’image du disque entier ou de la part ajoutée pour donner du sens."
    ]
  },
  "equation_premier_degre": {
    "keywords": [
      "équation du premier degré",
      "inequation du premier degré",
      "ax+b",
      "ax + b",
      "équation",
      "inéquation",
      "balance"
    ],
    "guidance": [
      "Proposer les deux méthodes : passage des termes avec changement de signe et méthode de l’équilibre / balance.",
      "Toujours rappeler que 3x signifie 3 fois x et qu’isoler x revient souvent à diviser.",
      "Expliquer chaque étape sans donner directement la réponse finale."
    ]
  },
  "lecture_graphique": {
    "keywords": [
      "image",
      "antécédent",
      "coordonnée",
      "abscisse",
      "ordonnée",
      "lecture graphique",
      "courbe",
      "graphique"
    ],
    "guidance": [
      "Toujours rappeler : abscisse en premier, ordonnée ensuite ; utiliser le point-virgule pour éviter les confusions.",
      "Dire explicitement : calculer une image, c’est remplacer x par la valeur donnée.",
      "Faire lire sur le graphique dès que c’est pertinent au lieu de partir dans du calcul inutile."
    ]
  },
  "statistiques_deux_variables": {
    "keywords": [
      "statistiques à deux variables",
      "nuage de points",
      "r²",
      "r2",
      "ajustement",
      "modèle affine",
      "modèle logarithmique",
      "modèle puissance"
    ],
    "guidance": [
      "Toujours partir de l’observation du nuage de points puis tester un ou deux modèles simples à la calculatrice.",
      "Dire clairement : plus R² est proche de 1, plus le modèle est pertinent.",
      "Ne jamais utiliser la méthode des moindres carrés ni des calculs théoriques de régression."
    ]
  },
  "probabilites": {
    "keywords": [
      "probabilité",
      "probabilités",
      "arbre",
      "sachant",
      "intersection",
      "événement"
    ],
    "guidance": [
      "Rester sur des arbres à deux niveaux maximum.",
      "Écrire P(A sachant B) en toutes lettres, pas de notation experte du type P(A/B).",
      "Traduire ET par × et OU par +, et corriger explicitement les confusions."
    ]
  },
  "suites": {
    "keywords": [
      "suite",
      "arithmétique",
      "géométrique",
      "raison",
      "u_n",
      "u_{n",
      "somme des termes"
    ],
    "guidance": [
      "Faire observer d’abord : ajoute-t-on toujours pareil ou multiplie-t-on toujours pareil ?",
      "Dire explicitement : augmentation = 100% + variation avant de calculer la raison géométrique.",
      "Pas de démonstration formelle, uniquement méthode, lecture et application."
    ]
  },
  "polynome_deg3": {
    "keywords": [
      "polynôme de degré 3",
      "polynome de degre 3",
      "fonction cube",
      "f'(x)=0",
      "f prime",
      "tableau de variation",
      "extremum local",
      "dérivée",
      "derivee"
    ],
    "guidance": [
      "Interdiction absolue d’utiliser le discriminant pour résoudre f’(x)=0 dans ce cadre bac pro.",
      "Toujours passer par la calculatrice, le tracé et la lecture graphique pour trouver les racines ou les points clés.",
      "Pour le tableau de variation, calculer les images aux bornes et aux points clés en disant explicitement qu’on remplace x par la valeur.",
      "Traduire le signe de la dérivée par une variation : positif = la fonction augmente, négatif = la fonction diminue."
    ]
  },
  "derivee_simple": {
    "keywords": [
      "dérivée",
      "derivee",
      "dériver",
      "dérivation"
    ],
    "guidance": [
      "Utiliser la logique simple : le coefficient descend et le degré diminue de 1.",
      "Décomposer le polynôme terme à terme avant de dériver.",
      "Pas de démonstration, pas de formalisme inutile."
    ]
  },
  "vecteurs": {
    "keywords": [
      "vecteur",
      "vecteurs",
      "norme",
      "colinéaire",
      "chasles"
    ],
    "guidance": [
      "Rester sur direction, sens, norme, coordonnées et calculs simples.",
      "En terminale espace : dire qu’on ajoute un axe qui sort du plan.",
      "Ne jamais utiliser le produit scalaire ni un raisonnement vectoriel avancé."
    ]
  },
  "trigonometrie": {
    "keywords": [
      "trigonométrie",
      "trigonometrie",
      "cercle trigonométrique",
      "sin",
      "cos",
      "phase"
    ],
    "guidance": [
      "Toujours partir du cercle trigonométrique et du visuel.",
      "Dire explicitement : cos = abscisse, sin = ordonnée.",
      "Corriger si besoin que le sens trigonométrique est le sens inverse des aiguilles d’une montre."
    ]
  },
  "expo_log": {
    "keywords": [
      "exponentielle",
      "logarithme",
      "log",
      "puissance",
      "q^x",
      "a^n"
    ],
    "guidance": [
      "Expliquer qu’une puissance est une multiplication répétée, jamais une simple multiplication du type 2×3.",
      "Rappeler les règles simples de calcul et le sens de variation selon la base.",
      "Pas de formalisme avancé ni de démonstration."
    ]
  },
  "calculs_commerciaux": {
    "keywords": [
      "intérêt simple",
      "intérêt composé",
      "valeur acquise",
      "coût moyen",
      "coût marginal",
      "devis",
      "facture",
      "capital"
    ],
    "guidance": [
      "Toujours identifier les données puis la bonne formule avant de calculer.",
      "Demander ou vérifier l’unité de temps ou l’unité commerciale avant de conclure.",
      "Interdiction de partir dans une analyse économique ou des dérivations hors cadre."
    ]
  }
};


function inferNotions(session, message = "") {
  const haystack = normalizeText([
    session.level,
    session.domain,
    session.chapter,
    ...(session.capacities || []),
    ...(session.knowledge || []),
    ...(session.automatisms || []),
    session.teacherSupport || "",
    message || ""
  ].join(" | "));

  return Object.entries(NOTION_RULES)
    .filter(([, cfg]) => (cfg.keywords || []).some((keyword) => haystack.includes(normalizeText(keyword))))
    .map(([key]) => key);
}

function buildNotionGuidance(session, message = "") {
  const notions = inferNotions(session, message);
  if (!notions.length) {
    return "- Aucune notion transversale spécifique détectée.";
  }
  return notions.map((key) => {
    const cfg = NOTION_RULES[key];
    const lines = (cfg.guidance || []).map((line) => `  - ${line}`).join("\n");
    return `- ${key}\n${lines}`;
  }).join("\n");
}


function formatBullets(items) {
  return items && items.length ? items.map((item) => `- ${item}`).join("\n") : "- Non précisé";
}


function lastAssistantQuestion(history = []) {
  const items = Array.isArray(history) ? history : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.role !== "assistant") continue;
    const content = sanitizeText(item?.content || "", 2000);
    if (content.includes("?")) return content;
  }
  return "";
}

function looksLikeClosedAnswer(message = "") {
  const text = normalizeText(message);
  return ["oui", "non", "ok", "daccord", "d'accord", "vas y", "vas-y", "continue", "a", "b", "c", "d"].includes(text);
}

function buildSystemPrompt(session, message = "", options = {}) {
  const { intent = "methode", history = [] } = options;
  const program = PROGRAM_CONFIG[session.level];
  const chapterGuidance =
    (program && program.chapitres && program.chapitres[session.chapter]) ||
    "Reste strictement dans le cadre sélectionné.";
  const notionGuidance = buildNotionGuidance(session, message);

  const domainText = session.domain ? `- Domaine : ${session.domain}` : "";
  const chapterText = session.chapter ? `- Chapitre : ${session.chapter}` : "";
  const groupText = session.grouping ? `- Groupement : ${session.grouping}` : "";
  const lastTeacherLikeContext = lastAssistantQuestion(history);

  const strategyByIntent = {
    verification: "Valider ou corriger la réponse de l'élève, puis s'arrêter.",
    methode: "Répondre clairement à la question, donner si besoin un exemple proche, puis s'arrêter.",
    cours: "Donner un rappel bref et utile, puis s'arrêter.",
    enonce: "Répondre d'abord dans le contexte exact de l'énoncé, puis s'arrêter.",
    vague: "Demander une reformulation très courte.",
    calcul_direct: "Refuser le calcul direct, montrer la méthode sur un exemple différent, puis s'arrêter.",
    hors_sujet: "Recadrer brièvement sur les maths.",
    abus: "Refuser de faire à la place et proposer seulement une aide de méthode sur un exemple différent."
  };

  return `
Tu dois répondre uniquement en JSON valide.

Tu es ARIA, Agent de Réflexion Interactive pour l’Autonomie.
Tu es un agent pédagogique de mathématiques conçu pour aider l’élève à comprendre, structurer sa pensée et progresser sans jamais faire le travail à sa place.
Tu réponds toujours en français.

Contexte de session :
- Niveau : ${program ? program.label : session.level}
${domainText}
${chapterText}
${groupText}
- Style attendu : ${program ? program.tone : "sobre, précis"}
- Cadre général du chapitre : ${chapterGuidance}
- Mode : ${session.mode}
- Intention déjà détectée côté serveur : ${intent}
- Stratégie de réponse attendue : ${strategyByIntent[intent] || "Répondre sans faire à la place."}

Capacités explicitement travaillées :
${formatBullets(session.capacities)}

Connaissances de référence :
${formatBullets(session.knowledge)}

Automatismes ciblés :
${formatBullets(session.automatisms)}

Support / énoncé / exercices fournis :
${session.teacherSupport || "Aucun support supplémentaire fourni."}

Contraintes transversales par notion :
${notionGuidance}

Dernière question d'ARIA si utile :
${lastTeacherLikeContext || "Aucune."}

Règles absolues :
1. Tu ne fais jamais l'exercice complet à la place de l'élève.
2. Tu ne donnes jamais directement la réponse finale attendue pour une question de l'exercice.
3. Si l'élève demande une vérification et que sa réponse est juste, tu réponds simplement que c'est correct, sans relance inutile.
4. Si l'élève demande une vérification et que sa réponse est fausse, tu corriges brièvement ou tu montres où est l'erreur. Tu ne demandes comment il a fait que si l'erreur est vraiment ambiguë.
5. Si la demande est trop floue, tu demandes une reformulation utile et courte.
6. Si l'information est déjà dans le cours, l’énoncé ou le support fourni, tu réponds simplement à partir de ce contexte.
7. Si la demande relève d'un calcul direct, tu refuses le calcul et tu expliques la méthode à partir d'un exemple différent.
8. Si la demande vise clairement à faire à la place, tu bloques pédagogiquement.
9. Tu écris les mathématiques de façon simple et lisible en texte clair. Pas de pseudo-LaTeX, pas d’écriture illisible, pas de mise en forme lourde.
10. Tu restes brève : 2 à 4 phrases maximum dans la plupart des cas.
11. Tu ne poses pas de question de relance automatiquement.
12. Tu ne poses une question courte que dans deux cas :
   - si l'élève a donné une réponse fausse et que tu as besoin d'un point précis pour corriger ;
   - si tu viens de montrer un exemple différent et que tu l'invites à refaire son exercice.
13. Si la demande porte sur une grandeur ou une expression définie dans l'énoncé ou le support, tu réponds d'abord dans le contexte exact de l'exercice.
14. Tu ne sors pas du programme, du chapitre, des capacités, des notions ciblées ou du support fournis.
15. Tu n'utilises jamais l'exemple exact de l'élève si tu refuses de faire à sa place.
16. Si l'intention détectée est "abus" ou "calcul_direct", tu n'utilises ni la vraie fonction de l'élève, ni ses valeurs exactes, ni ses lettres exactes. Tu inventes un exemple différent, très proche en difficulté, puis tu t'arrêtes.
17. Tu évites toute écriture du type \\( ... \\), \\[ ... \\], backslashes, commandes LaTeX ou notation sale. Écris proprement en texte simple.
18. Tu évites de bombarder l'élève de questions. L'élève a déjà son exercice à traiter.

Important pour les catégories :
- "verification" = l'élève propose un résultat ou veut vérifier
- "methode" = demande utile de méthode / explication / compréhension
- "cours" = rappel disponible dans le cours ou notion déjà vue
- "enonce" = l'information est déjà dans l’énoncé ou le support fourni par l’enseignant
- "vague" = demande trop floue ou trop incomplète
- "calcul_direct" = outil peu adapté (ex : calcul direct, calculatrice plus adaptée)
- "hors_sujet" = moteur de recherche / hors sujet / autre outil plus pertinent
- "abus" = faire à la place / réponse toute faite / demande abusive

Tu renvoies uniquement un JSON avec cette structure :
{
  "intention": "methode",
  "reponse": "ta réponse",
  "demande_reformulation": false
}

Valeurs autorisées pour intention :
- verification
- methode
- cours
- enonce
- calcul_direct
- hors_sujet
- vague
- abus
`;
}



function responsePolicyForIntent(intent) {
  switch (intent) {
    case "abus":
      return {
        allowModel: true,
        demande_reformulation: false,
        answer: ""
      };
    case "calcul_direct":
      return {
        allowModel: true,
        demande_reformulation: false,
        answer: ""
      };
    case "hors_sujet":
      return {
        allowModel: false,
        demande_reformulation: false,
        answer: "Ici, je reste centrée sur le travail de mathématiques. Reformule ton blocage mathématique."
      };
    case "vague":
      return {
        allowModel: false,
        demande_reformulation: true,
        answer: "Ta demande est trop floue. Donne-moi la question exacte, ton essai, ou l'étape qui bloque."
      };
    case "cours":
    case "enonce":
    case "verification":
    case "methode":
    default:
      return { allowModel: true, demande_reformulation: false, answer: "" };
  }
}

function detectPedagogicalIntent(session = {}, message = "", history = []) {
  const text = normalizeText(message);
  if (!text) return "vague";

  const words = text.split(/\s+/).filter(Boolean);
  const previousAssistantQuestion = normalizeText(lastAssistantQuestion(history));
  const isReplyToAssistantQuestion = Boolean(previousAssistantQuestion);
  const closedReplyAccepted = looksLikeClosedAnswer(message) && isReplyToAssistantQuestion;
  const containsMathExpression =
    /[=+\-*/^()]/.test(message) ||
    /[a-z]\s*'\s*\(/i.test(message) ||
    /\d/.test(message);

  // =========================
  // 🔴 1. ABUS (PRIORITAIRE)
  // =========================

  const minimalAbuse =
    /^\s*(exo|question|\d+(\.\d+)?)[\s?]*$/.test(text);

  const asksDirectAnswer =
    /fais|donne|resous|résous/.test(text) &&
    /(exo|exercice|question|partie|\d)/.test(text);

  if (minimalAbuse || asksDirectAnswer) return "abus";

  if (text.includes("help3")) return "abus";

  // =========================
  // 🟢 2. DEMANDE MÉTHODE
  // =========================

  const asksHowTo =
    /comment|explique|aide|je comprends pas|j'arrive pas/.test(text);

  if (asksHowTo) return "methode";

  // =========================
  // 🟠 3. CALCUL DIRECT
  // =========================

  const asksCalculatorLike =
    /calcule|combien|résultat|resultat|ça donne|ca donne|valeur/.test(text) ||
    /\b[cfgh]\s*\(/.test(text);

  if (asksCalculatorLike) return "calcul_direct";

  // =========================
  // 🟢 4. VERIFICATION
  // =========================

  const asksVerification =
    /verifie|vérifie|corrige|c'est bon|est ce juste|est-ce juste/.test(text);

  const hasOwnAttempt =
    /j'ai|jai|j’obtiens|j'obtiens|mon resultat|mon résultat/.test(text);

  if (asksVerification || hasOwnAttempt) return "verification";

  if (
    isReplyToAssistantQuestion &&
    (closedReplyAccepted || containsMathExpression || words.length <= 8)
  ) {
    return "verification";
  }

  // =========================
  // 🔵 5. HORS SUJET
  // =========================

  const asksSearchLike =
    /google|wikipedia|date de|qui a invente|qui a inventé/.test(text);

  if (asksSearchLike) return "hors_sujet";

  // =========================
  // 🟡 6. ENONCE
  // =========================

  const asksEnonceLike =
    /c'?est quoi [a-z]|que represente|que représente|que veut dire/.test(text);

  if (asksEnonceLike) return "enonce";

  // =========================
  // 🟡 7. COURS
  // =========================

  const asksDefinition =
    /c'?est quoi|definition|définition|ça veut dire/.test(text);

  if (asksDefinition) return "cours";

  // =========================
  // 🟣 8. FLOU
  // =========================

  if (
    words.length <= 2 &&
    !containsMathExpression &&
    !closedReplyAccepted
  ) {
    return "vague";
  }

  // =========================
  // 🟢 DEFAULT
  // =========================

  return "methode";
}

function fallbackIntent(message = "", history = [], session = null) {
  return detectPedagogicalIntent(session || {}, message, history);
}


function mapIntentToMeta(intent) {
  switch (intent) {
    case "verification":
      return {
        label: "verification",
        credits: 10,
        color: "green",
        exportLabel: "Aide utile / vérification",
        scoreLabel: "Aide utile",
        impactIA: "pertinent",
        impactLabel: "Usage pertinent de l'IA",
        messageScore: "Demande utile : vérification, méthode ou explication."
      };

    case "methode":
      return {
        label: "methode",
        credits: 10,
        color: "green",
        exportLabel: "Aide utile / méthode",
        scoreLabel: "Aide utile",
        impactIA: "pertinent",
        impactLabel: "Usage pertinent de l'IA",
        messageScore: "Demande utile : vérification, méthode ou explication."
      };

    case "cours":
      return {
        label: "cours",
        credits: 20,
        color: "yellow",
        exportLabel: "Rappel disponible / cours",
        scoreLabel: "Rappel disponible",
        impactIA: "limite",
        impactLabel: "Usage de l'IA à questionner",
        messageScore: "Cette information relevait d’un rappel déjà disponible dans le cours ou les supports."
      };

    case "enonce":
      return {
        label: "enonce",
        credits: 20,
        color: "yellow",
        exportLabel: "Rappel disponible / énoncé-support",
        scoreLabel: "Rappel disponible",
        impactIA: "limite",
        impactLabel: "Usage de l'IA à questionner",
        messageScore: "Cette information relevait d’un rappel déjà disponible dans le cours ou les supports."
      };

    case "vague":
      return {
        label: "vague",
        credits: 30,
        color: "orange",
        exportLabel: "Demande floue",
        scoreLabel: "Demande floue",
        impactIA: "limite",
        impactLabel: "Usage de l'IA à questionner",
        messageScore: "Ta demande est trop floue. Plus tu précises ton blocage, plus l'aide sera utile."
      };

    case "calcul_direct":
      return {
        label: "calcul_direct",
        credits: 40,
        color: "orange",
        exportLabel: "Outil peu adapté / calculatrice",
        scoreLabel: "Outil peu adapté",
        impactIA: "inutile",
        impactLabel: "Usage inutile de l'IA",
        messageScore: "Ici, l'IA n'est pas l'outil le plus pertinent."
      };

    case "hors_sujet":
      return {
        label: "hors_sujet",
        credits: 40,
        color: "orange",
        exportLabel: "Outil peu adapté / moteur de recherche",
        scoreLabel: "Outil peu adapté",
        impactIA: "inutile",
        impactLabel: "Usage inutile de l'IA",
        messageScore: "Ici, l'IA n'est pas l'outil le plus pertinent."
      };

    case "abus":
      return {
        label: "abus",
        credits: 50,
        color: "red",
        exportLabel: "Faire à la place / hors sujet / abus",
        scoreLabel: "Faire à la place / abus",
        impactIA: "a_eviter",
        impactLabel: "Usage à éviter",
        messageScore: "Ici, l'IA prend la place du raisonnement de l'élève."
      };

    default:
      return {
        label: "methode",
        credits: 10,
        color: "green",
        exportLabel: "Aide utile / méthode",
        scoreLabel: "Aide utile",
        impactIA: "pertinent",
        impactLabel: "Usage pertinent de l'IA",
        messageScore: "Demande utile : vérification, méthode ou explication."
      };
  }
}

function sanitizeSessionForClient(session) {
  return {
    sessionId: session.id,
    code: session.code,
    teacherName: session.teacherName,
    level: session.level,
    levelLabel: PROGRAM_CONFIG[session.level] ? PROGRAM_CONFIG[session.level].label : session.level,
    domain: session.domain || "",
    chapter: session.chapter,
    mode: session.mode,
    modeLabel: MODES[session.mode] ? MODES[session.mode].label : session.mode,
    initialCredits: session.initialCredits,
    teacherContext: session.teacherContext,
    teacherSupport: session.teacherSupport,
    capacities: session.capacities || [],
    knowledge: session.knowledge || [],
    automatisms: session.automatisms || [],
    grouping: session.grouping || "",
    createdAt: session.createdAt,
    isActive: session.isActive,
  };
}

function buildChatResponse({ answer, meta, session, participant, reformulation = false }) {
  const showScoreDetails = Boolean(MODES[session.mode]?.showScoreDetails);

  return {
    answer,
    creditsUsed: meta.credits,
    creditsRemaining: participant.creditsRemaining,
    requestsCount: participant.requestsCount,
    category: meta.label,
    dotColor: meta.color,
    exportLabel: meta.exportLabel,
    timestamp: nowIso(),
    showScoreDetails,
    scoreLabel: showScoreDetails ? meta.scoreLabel : null,
    impactIA: showScoreDetails ? meta.impactIA : null,
    impactLabel: showScoreDetails ? meta.impactLabel : null,
    messageScore: showScoreDetails ? meta.messageScore : null,
    demande_reformulation: reformulation,
  };
}

function getSessionByCode(code) {
  return sessionsStore.get(String(code || "").trim().toUpperCase());
}

function buildAssessmentPrompt(session, recentHistory = []) {
  const historyText = recentHistory.length
    ? recentHistory.slice(-8).map((item) => `${item.role === "assistant" ? "Assistant" : "Élève"} : ${item.content}`).join("\n")
    : "Aucun échange disponible.";

  return `
Tu dois répondre uniquement en JSON valide.

Tu es ARIA, agent tuteur de mathématiques.
Tu prépares un mini-bilan de compréhension en 5 questions maximum, sans sortir du cadre pédagogique fourni.

Contexte :
- Niveau : ${PROGRAM_CONFIG[session.level] ? PROGRAM_CONFIG[session.level].label : session.level}
- Domaine : ${session.domain || "Non précisé"}
- Chapitre : ${session.chapter || "Non précisé"}

Capacités travaillées :
${formatBullets(session.capacities)}

Connaissances de référence :
${formatBullets(session.knowledge)}

Automatismes ciblés :
${formatBullets(session.automatisms)}

Support enseignant :
${session.teacherSupport || "Aucun support fourni."}

Contraintes transversales par notion :
${buildNotionGuidance(session)}

Historique récent :
${historyText}

Consignes :
1. Génère 5 questions maximum.
2. Les questions doivent s'appuyer d'abord sur les capacités sélectionnées.
3. Si aucune capacité n'est fournie, appuie-toi sur le chapitre et le support.
4. Questions courtes, claires, adaptées au niveau.
5. Pas de questions hors programme.
6. Ne recopie jamais l’exercice ou le support mot pour mot.
7. Préfère des questions de vérification, de compréhension, d’identification de méthode ou de lecture.
8. Évite les calculs lourds, les formulations piégeuses et les réponses trop ouvertes.
9. Tu peux varier entre application, compréhension, justification, vérification.
10. Chaque question doit être un QCM à 4 choix exactement.
11. Fournis pour chaque question :
- "question"
- "choices" : tableau de 4 réponses courtes
- "correctAnswer" : une des 4 réponses
- "explanation" : justification courte
12. Quand une question exploite un tableau de valeurs, écris le tableau directement dans "question" sur plusieurs lignes, par exemple :
x : -1 0 2 5
f(x) : 3 4 7 9
13. Évite les dollars isolés. Utilise une écriture propre et lisible.

Format :
{
  "cta_label": "Voir où j'en suis",
  "warning_title": "Faire le point",
  "warning_text": "Tu t’apprêtes à vérifier ce que tu as compris.",
  "questions": [
    {
      "id": "q1",
      "label": "Question 1",
      "question": "...",
      "choices": ["...", "...", "...", "..."],
      "correctAnswer": "...",
      "explanation": "..."
    }
  ]
}
`;
}


function cleanLatexArtifacts(value = "", maxLen = 500) {
  return sanitizeText(String(value || "").replace(/\$(.*?)\$/g, "$1").replace(/\$\$/g, ""), maxLen);
}

function buildFallbackChoices(questionText = "", notion = "") {
  const q = normalizeText(`${questionText} ${notion}`);
  if (q.includes("image")) return ["On calcule f(0)", "On cherche x", "On résout f(x)=0", "On lit seulement la ligne de x"];
  if (q.includes("antecedent")) return ["La valeur de x", "La valeur de f(x)", "Le coefficient", "La pente"];
  if (q.includes("tableau")) return ["Dans la ligne de x", "Dans la ligne de f(x)", "Dans les deux lignes", "Nulle part"];
  return ["Je justifie la méthode", "Je calcule directement", "Je recopie l’énoncé", "Je donne un résultat au hasard"];
}

function normalizeQuestionChoices(question = {}, index = 0, session = null) {
  const rawChoices = Array.isArray(question?.choices) ? question.choices : Array.isArray(question?.options) ? question.options : Array.isArray(question?.propositions) ? question.propositions : [];
  let choices = rawChoices.map((item) => cleanLatexArtifacts(item, 200)).filter(Boolean).slice(0, 4);
  if (choices.length < 4) {
    const fallback = buildFallbackChoices(question?.question || "", session?.chapter || "");
    for (const item of fallback) {
      if (choices.length >= 4) break;
      if (!choices.includes(item)) choices.push(item);
    }
  }
  const correctAnswer = cleanLatexArtifacts(question?.correctAnswer || question?.answer || choices[0] || "", 200);
  if (correctAnswer && !choices.includes(correctAnswer)) {
    if (choices.length < 4) choices.push(correctAnswer);
    else choices[choices.length - 1] = correctAnswer;
  }
  return {
    id: sanitizeText(question?.id, 40) || `q${index + 1}`,
    label: cleanLatexArtifacts(question?.label || `Question ${index + 1}`, 80) || `Question ${index + 1}`,
    question: cleanLatexArtifacts(question?.question || `Explique ou applique : ${session?.chapter || "la notion travaillée"}`, 900),
    choices: choices.slice(0, 4),
    correctAnswer: correctAnswer || choices[0] || "",
    explanation: cleanLatexArtifacts(question?.explanation || "", 400)
  };
}

async function generateAssessment(session, participant) {
  const recentHistory = Array.isArray(participant.history) ? participant.history : [];
  const completion = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: buildAssessmentPrompt(session, recentHistory) }],
      }
    ],
    text: { format: { type: "json_object" } }
  });

  const raw = completion.output_text || "";
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    parsed = null;
  }

  const fallbackQuestions = (session.capacities && session.capacities.length ? session.capacities : [
    session.chapter || "Notion du chapitre"
  ]).slice(0, 5).map((item, index) => normalizeQuestionChoices({
    id: `q${index + 1}`,
    label: `Question ${index + 1}`,
    question: `Explique ou applique : ${item}`,
    choices: buildFallbackChoices(String(item || ""), session.chapter || "")
  }, index, session));

  return {
    cta_label: sanitizeText(parsed?.cta_label, 80) || "Voir où j'en suis",
    warning_title: sanitizeText(parsed?.warning_title, 120) || "Faire le point",
    warning_text: sanitizeText(parsed?.warning_text, 300) || "Tu t’apprêtes à vérifier ce que tu as compris.",
    questions: Array.isArray(parsed?.questions) && parsed.questions.length
      ? parsed.questions.slice(0, 5).map((q, index) => normalizeQuestionChoices(q, index, session))
      : fallbackQuestions
  };
}


async function gradeAssessmentWithAI(session, questions = [], answers = []) {
  const prompt = `
Tu dois répondre uniquement en JSON valide.

Tu es ARIA. Tu corriges un mini-bilan de mathématiques de niveau bac pro.
Tu évalues avec souplesse et intelligence : une réponse mathématiquement correcte ne doit pas être pénalisée pour un détail de forme, d'espace ou de ponctuation.
Tu ne notes pas sur la longueur mais sur la justesse, la compréhension et la méthode.

Contexte :
- Niveau : ${PROGRAM_CONFIG[session.level] ? PROGRAM_CONFIG[session.level].label : session.level}
- Domaine : ${session.domain || "Non précisé"}
- Chapitre : ${session.chapter || "Non précisé"}
- Capacités ciblées :
${formatBullets(session.capacities)}
- Connaissances :
${formatBullets(session.knowledge)}

Questions et réponses élève :
${questions.map((q, i) => `Question ${i + 1} : ${q.question || q.label || ""}\nRéponse élève : ${answers[i]?.answer || ""}`).join("\n\n")}

Consignes de correction :
1. Attribue 0, 1 ou 2 points par question.
2. 2 = réponse juste ou globalement juste avec une formulation acceptable.
3. 1 = compréhension partielle, bonne méthode ou réponse incomplète.
4. 0 = hors sujet, vide ou faux de manière majeure.
5. Si la réponse est correcte mais écrite autrement, donne les points.
6. Ne pénalise pas un manque d'espace, une écriture équivalente ou un détail de présentation.
7. Pour une dérivée correcte, même sans mise en forme parfaite, donne 2.
8. Donne un feedback court et utile par question.
9. Retourne aussi :
- ce qui est acquis
- ce qu’il faut retravailler
- un conseil de reprise

Format JSON attendu :
{
  "perQuestion": [
    { "id": "q1", "score": 2, "feedback": "..." }
  ],
  "strengths": ["..."],
  "needsWork": ["..."],
  "advice": "..."
}
`;
  const completion = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [{ role: "system", content: [{ type: "input_text", text: prompt }] }],
    text: { format: { type: "json_object" } }
  });
  const raw = completion.output_text || "";
  return JSON.parse(raw);
}

function scoreAnswer(answer = "") {
  const t = sanitizeText(answer, 1500);
  if (!t) return 0;
  const lowered = normalizeText(t);
  if (["ok", "oui", "non", "jsp", "je sais pas", "je ne sais pas"].includes(lowered)) return 0;
  if (t.length < 18) return 0;
  if (t.length < 55) return 1;
  return 2;
}

function buildAssessmentFeedback(totalScore, maxScore) {
  const ratio = maxScore ? totalScore / maxScore : 0;
  if (ratio >= 0.8) {
    return {
      level: "Solide",
      summary: "Tu sembles bien maîtriser l’essentiel de ce qui a été travaillé.",
      advice: "Continue à justifier proprement et à vérifier tes résultats."
    };
  }
  if (ratio >= 0.5) {
    return {
      level: "En progrès",
      summary: "Tu as compris une partie importante, mais certaines notions restent fragiles.",
      advice: "Reprends les questions qui t’ont posé problème et refais un exemple proche."
    };
  }
  return {
    level: "À renforcer",
    summary: "Plusieurs points restent fragiles ou trop flous.",
    advice: "Reprends l’exercice avec l’assistant, demande une aide plus ciblée, puis refais le bilan."
  };
}

function computeSessionSummary(sessionCode) {
  const session = getSessionByCode(sessionCode);
  if (!session) return null;

  const sessionParticipants = [...participantsStore.values()].filter((p) => p.sessionId === session.id);
  const sessionAnalyses = analysesStore.filter((a) => a.sessionId === session.id);
  const sessionAssessments = assessmentsStore.filter((a) => a.sessionId === session.id);
  const totalRequests = sessionAnalyses.length;
  const activeParticipants = sessionParticipants.length;

  const distributionCounts = {
    methode: 0,
    verification: 0,
    enonce: 0,
    cours: 0,
    vague: 0,
    calcul_direct: 0,
    hors_sujet: 0,
    abus: 0,
  };

  let usefulCount = 0;
  for (const item of sessionAnalyses) {
    if (distributionCounts[item.category] !== undefined) {
      distributionCounts[item.category] += 1;
    }
    if (item.category === "methode" || item.category === "verification") {
      usefulCount += 1;
    }
  }

  const distributionPercentages = Object.fromEntries(
    Object.entries(distributionCounts).map(([key, value]) => [
      key,
      totalRequests ? Math.round((value / totalRequests) * 100) : 0,
    ])
  );

  const averageRequestsPerParticipant = activeParticipants
    ? Number((totalRequests / activeParticipants).toFixed(1))
    : 0;

  const averageCreditsRemaining = activeParticipants
    ? Math.round(
        sessionParticipants.reduce((sum, participant) => sum + participant.creditsRemaining, 0) / activeParticipants
      )
    : session.initialCredits;

  const averagePertinence = totalRequests ? Math.round((usefulCount / totalRequests) * 100) : 0;

  const completedAssessments = new Set(sessionAssessments.map((item) => item.participantId)).size;
  const averageAssessmentScore = completedAssessments
    ? Number((sessionAssessments.reduce((sum, item) => sum + item.totalScore, 0) / completedAssessments).toFixed(1))
    : 0;

  return {
    session: sanitizeSessionForClient(session),
    totalRequests,
    activeParticipants,
    averageRequestsPerParticipant,
    averageCreditsRemaining,
    averagePertinence,
    completedAssessments,
    averageAssessmentScore,
    distributionCounts,
    distributionPercentages,
    participantSummaries: sessionParticipants.map((participant) => ({
      participantId: participant.id,
      name: participant.name,
      requestsCount: participant.requestsCount,
      creditsRemaining: participant.creditsRemaining,
      lastAssessmentScore: participant.lastAssessmentScore ?? null,
      createdAt: participant.createdAt,
    })),
  };
}

function toCsvCell(value) {
  const safe = String(value ?? "").replace(/"/g, '""');
  return `"${safe}"`;
}

function buildSessionCsv(sessionCode) {
  const session = getSessionByCode(sessionCode);
  if (!session) return "";

  const chatRows = analysesStore
    .filter((item) => item.sessionId === session.id)
    .map((item) => [
      "chat",
      item.timestamp,
      item.participantName,
      item.userMessage,
      item.category,
      item.scoreLabel,
      item.impactIA,
      item.creditsUsed,
      item.creditsRemainingAfter,
      item.assistantAnswer,
      "",
      "",
      ""
    ]);

  const assessmentRows = assessmentsStore
    .filter((item) => item.sessionId === session.id)
    .map((item) => [
      "bilan",
      item.timestamp,
      item.participantName,
      "",
      "bilan",
      item.feedbackLevel,
      "",
      "",
      "",
      item.feedbackSummary,
      item.totalScore,
      item.maxScore,
      item.feedbackAdvice
    ]);

  const headers = [
    "type",
    "horodatage",
    "participant",
    "demande",
    "categorie",
    "label_score",
    "impact_ia",
    "credits_utilises",
    "credits_restants",
    "reponse_assistant_ou_bilan",
    "score_bilan",
    "score_max",
    "conseil"
  ];

  return [
    headers.map(toCsvCell).join(";"),
    ...chatRows.map((row) => row.map(toCsvCell).join(";")),
    ...assessmentRows.map((row) => row.map(toCsvCell).join(";"))
  ].join("\n");
}

app.get("/api/reference/maths", (req, res) => {
  if (!MATHS_REFERENCE) {
    return res.status(404).json({ error: "Référentiel maths indisponible." });
  }
  return res.json(MATHS_REFERENCE);
});

app.post("/api/sessions", (req, res) => {
  const {
    teacherName = "",
    level,
    chapter,
    domain = "",
    grouping = "",
    capacities = [],
    knowledge = [],
    automatisms = [],
    mode = "decouverte",
    initialCredits = DEFAULT_INITIAL_CREDITS,
    teacherContext = "",
    teacherSupport = ""
  } = req.body || {};

  if (!PROGRAM_CONFIG[level]) {
    return res.status(400).json({ error: "Niveau invalide." });
  }

  if (!chapter || !sanitizeText(chapter, 200)) {
    return res.status(400).json({ error: "Chapitre invalide pour ce niveau." });
  }

  if (!MODES[mode]) {
    return res.status(400).json({ error: "Mode invalide." });
  }

  let code;
  do {
    code = createSessionCode();
  } while (sessionsStore.has(code));

  const session = {
    id: crypto.randomUUID(),
    code,
    teacherName: sanitizeText(teacherName, 120),
    level,
    domain: sanitizeText(domain, 160),
    grouping: sanitizeText(grouping, 80),
    chapter: sanitizeText(chapter, 200),
    capacities: sanitizeArray(capacities, 30, 240),
    knowledge: sanitizeArray(knowledge, 40, 240),
    automatisms: sanitizeArray(automatisms, 40, 240),
    mode,
    initialCredits: Number(initialCredits) || DEFAULT_INITIAL_CREDITS,
    teacherContext: sanitizeText(teacherContext, 4000),
    teacherSupport: sanitizeText(teacherSupport, 12000),
    createdAt: nowIso(),
    isActive: true,
  };

  sessionsStore.set(code, session);
  return res.status(201).json(sanitizeSessionForClient(session));
});

app.get("/api/sessions/:code", (req, res) => {
  const session = getSessionByCode(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "Session introuvable." });
  }
  return res.json(sanitizeSessionForClient(session));
});

app.post("/api/sessions/:code/join", (req, res) => {
  const session = getSessionByCode(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "Session introuvable." });
  }

  if (!session.isActive) {
    return res.status(403).json({ error: "Cette session est fermée." });
  }

  const { name = "Élève" } = req.body || {};

  const participant = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    sessionCode: session.code,
    name: sanitizeText(name, 80) || "Élève",
    createdAt: nowIso(),
    creditsInitial: session.initialCredits,
    creditsRemaining: session.initialCredits,
    requestsCount: 0,
    history: [],
    lastAssessmentScore: null,
    lastAssessmentId: null,
  };

  participantsStore.set(participant.id, participant);

  return res.status(201).json({
    participantId: participant.id,
    name: participant.name,
    creditsInitial: participant.creditsInitial,
    creditsRemaining: participant.creditsRemaining,
    requestsCount: participant.requestsCount,
    session: sanitizeSessionForClient(session),
  });
});

app.post("/api/sessions/:code/chat", async (req, res) => {
  try {
    const session = getSessionByCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: "Session introuvable." });
    }

    const { participantId, message, history = [] } = req.body || {};
    const participant = participantsStore.get(String(participantId || ""));

    if (!participant || participant.sessionId !== session.id) {
      return res.status(404).json({ error: "Participant introuvable pour cette session." });
    }

    const safeMessage = sanitizeText(message, 3000);
    if (!safeMessage) {
      return res.status(400).json({ error: "Message vide." });
    }

    if (participant.creditsRemaining <= 0) {
      return res.status(403).json({
        blocked: true,
        message: "Tu as utilisé tous tes crédits pour cette session. Tu dois maintenant terminer sans moi.",
        creditsRemaining: 0,
        requestsCount: participant.requestsCount,
      });
    }

    const mergedHistory = [
      ...(Array.isArray(participant.history) ? participant.history.slice(-4) : []),
      ...history.slice(-4).map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: sanitizeText(item.content, 2000),
      })).filter((item) => item.content)
    ];

    const serverIntent = detectPedagogicalIntent(session, safeMessage, mergedHistory);
    const meta = mapIntentToMeta(serverIntent);
    const policy = responsePolicyForIntent(serverIntent);

    let answer = "";
    let reformulation = Boolean(policy.demande_reformulation);

    if (!policy.allowModel) {
      answer = policy.answer;
    } else {
      const systemPrompt = buildSystemPrompt(session, safeMessage, { intent: serverIntent, history: mergedHistory });

      const inputMessages = [
        ...mergedHistory.slice(-4).map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: sanitizeText(item.content, 2000),
        })).filter((item) => item.content),
        { role: "user", content: safeMessage },
      ];

    const completion = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        ...inputMessages.map((item) => ({
          role: item.role,
          content: [{
            type: item.role === "assistant" ? "output_text" : "input_text",
            text: item.content,
          }],
        })),
      ],
      text: { format: { type: "json_object" } },
    });

      const raw = completion.output_text || "";
      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        parsed = {
          intention: serverIntent,
          reponse: raw || "Je n'ai pas réussi à répondre correctement.",
          demande_reformulation: false,
        };
      }

      answer = sanitizeText(parsed.reponse || "Je n'ai pas réussi à répondre correctement.", 4000);
      reformulation = Boolean(parsed.demande_reformulation);
    }

    participant.requestsCount += 1;
    participant.creditsRemaining = Math.max(0, participant.creditsRemaining - meta.credits);
    participant.history.push({ role: "user", content: safeMessage });
    participant.history.push({ role: "assistant", content: answer });

    analysesStore.push({
      id: crypto.randomUUID(),
      sessionId: session.id,
      sessionCode: session.code,
      participantId: participant.id,
      participantName: participant.name,
      userMessage: safeMessage,
      assistantAnswer: answer,
      category: meta.label,
      scoreLabel: meta.scoreLabel,
      impactIA: meta.impactIA,
      creditsUsed: meta.credits,
      creditsRemainingAfter: participant.creditsRemaining,
      timestamp: nowIso(),
    });

    const payload = buildChatResponse({
      answer,
      meta,
      session,
      participant,
      reformulation,
    });

    payload.blocked = participant.creditsRemaining <= 0;
    payload.blockMessage = payload.blocked
      ? "Tu as utilisé tous tes crédits pour cette session. Tu dois maintenant terminer sans moi."
      : null;

    return res.json(payload);
  } catch (error) {
    console.error("ERREUR OPENAI :", error);

    return res.status(500).json({
      error: "Erreur IA",
      answer: "Erreur IA",
      creditsUsed: 0,
      creditsRemaining: null,
      requestsCount: null,
      category: "erreur",
      dotColor: "red",
      exportLabel: "Erreur IA",
      timestamp: nowIso(),
      showScoreDetails: false,
      scoreLabel: null,
      impactIA: null,
      impactLabel: null,
      messageScore: null,
      demande_reformulation: false,
    });
  }
});

app.post("/api/sessions/:code/assessment/start", async (req, res) => {
  try {
    const session = getSessionByCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: "Session introuvable." });
    }

    const { participantId } = req.body || {};
    const participant = participantsStore.get(String(participantId || ""));

    if (!participant || participant.sessionId !== session.id) {
      return res.status(404).json({ error: "Participant introuvable pour cette session." });
    }

    const assessment = await generateAssessment(session, participant);
    const assessmentId = crypto.randomUUID();

    participant.lastAssessmentId = assessmentId;
    participant.lastAssessmentQuestions = Array.isArray(assessment.questions) ? assessment.questions : [];

    return res.json({
      assessmentId,
      ...assessment
    });
  } catch (error) {
    console.error("ERREUR START ASSESSMENT :", error);
    return res.status(500).json({ error: "Impossible de générer le bilan." });
  }
});

app.post("/api/sessions/:code/check-start", async (req, res) => {
  try {
    const session = getSessionByCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: "Session introuvable." });
    }

    const { participantId } = req.body || {};
    const participant = participantsStore.get(String(participantId || ""));

    if (!participant || participant.sessionId !== session.id) {
      return res.status(404).json({ error: "Participant introuvable pour cette session." });
    }

    const assessment = await generateAssessment(session, participant);
    const assessmentId = crypto.randomUUID();

    participant.lastAssessmentId = assessmentId;
    participant.lastAssessmentQuestions = Array.isArray(assessment.questions) ? assessment.questions : [];

    return res.json({
      assessmentId,
      ...assessment
    });
  } catch (error) {
    console.error("ERREUR START ASSESSMENT :", error);
    return res.status(500).json({ error: "Impossible de générer le bilan." });
  }
});

app.post("/api/sessions/:code/assessment/submit", async (req, res) => {
  try {
    const session = getSessionByCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: "Session introuvable." });
    }

    const { participantId, assessmentId = "", answers = [] } = req.body || {};
    const participant = participantsStore.get(String(participantId || ""));

    if (!participant || participant.sessionId !== session.id) {
      return res.status(404).json({ error: "Participant introuvable pour cette session." });
    }

    const sourceQuestions = Array.isArray(participant.lastAssessmentQuestions) ? participant.lastAssessmentQuestions : [];
    const sanitizedAnswers = Array.isArray(answers)
      ? answers.slice(0, 5).map((item, index) => {
          const source = sourceQuestions[index] || {};
          return {
            questionId: sanitizeText(item?.questionId || source?.id || `q${index + 1}`, 40),
            question: cleanLatexArtifacts(item?.question || source?.question || "", 900),
            answer: cleanLatexArtifacts(item?.answer || "", 2000),
            correctAnswer: cleanLatexArtifacts(source?.correctAnswer || "", 200),
            explanation: cleanLatexArtifacts(source?.explanation || "", 400),
            choices: Array.isArray(source?.choices) ? source.choices.map((choice) => cleanLatexArtifacts(choice, 200)).filter(Boolean).slice(0,4) : []
          };
        })
      : [];

    const aiResult = await gradeAssessmentWithAI(session, sourceQuestions.length ? sourceQuestions : sanitizedAnswers, sanitizedAnswers);
    const perQuestion = Array.isArray(aiResult?.perQuestion) ? aiResult.perQuestion : [];
    const detailed = sanitizedAnswers.map((item, index) => {
      const aiItem = perQuestion[index] || {};
      const normalizedUser = normalizeText(item.answer);
      const normalizedCorrect = normalizeText(item.correctAnswer);
      const directScore = normalizedUser && normalizedCorrect ? (normalizedUser === normalizedCorrect ? 2 : 0) : null;
      const safeScore = directScore !== null ? directScore : ([0,1,2].includes(aiItem.score) ? aiItem.score : scoreAnswer(item.answer));
      return {
        ...item,
        score: safeScore,
        feedback: sanitizeText(aiItem.feedback || item.explanation || "", 400),
        correctAnswer: item.correctAnswer
      };
    });

    const totalScore = detailed.reduce((sum, item) => sum + item.score, 0);
    const maxScore = sanitizedAnswers.length * 2;
    const weakPoints = (aiResult?.needsWork || []).slice(0, 6);
    const strengths = (aiResult?.strengths || []).slice(0, 6);
    const feedback = buildAssessmentFeedback(totalScore, maxScore);

    const entry = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      sessionCode: session.code,
      participantId: participant.id,
      participantName: participant.name,
      assessmentId: sanitizeText(assessmentId, 80) || participant.lastAssessmentId || "",
      totalScore,
      maxScore,
      feedbackLevel: feedback.level,
      feedbackSummary: feedback.summary,
      feedbackAdvice: sanitizeText(aiResult?.advice || feedback.advice, 600) || feedback.advice,
      weakPoints,
      strengths,
      answers: detailed,
      timestamp: nowIso(),
    };

    participant.lastAssessmentScore = totalScore;
    participant.lastAssessmentId = entry.assessmentId;

    const existingIndex = assessmentsStore.findIndex((item) => item.sessionId === session.id && item.participantId === participant.id);
    if (existingIndex >= 0) {
      assessmentsStore[existingIndex] = entry;
    } else {
      assessmentsStore.push(entry);
    }

    return res.json({
      score: totalScore,
      maxScore,
      level: feedback.level,
      summary: feedback.summary,
      advice: sanitizeText(aiResult?.advice || feedback.advice, 600) || feedback.advice,
      strengths,
      needsWork: weakPoints,
      perQuestion: detailed
    });
  } catch (error) {
    console.error("ERREUR SUBMIT ASSESSMENT :", error);
    return res.status(500).json({ error: "Impossible de corriger le bilan." });
  }
});

app.post("/api/sessions/:code/check-submit", async (req, res) => {
  try {
    const session = getSessionByCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: "Session introuvable." });
    }

    const { participantId, assessmentId = "", answers = [] } = req.body || {};
    const participant = participantsStore.get(String(participantId || ""));

    if (!participant || participant.sessionId !== session.id) {
      return res.status(404).json({ error: "Participant introuvable pour cette session." });
    }

    const sourceQuestions = Array.isArray(participant.lastAssessmentQuestions) ? participant.lastAssessmentQuestions : [];
    const sanitizedAnswers = Array.isArray(answers)
      ? answers.slice(0, 5).map((item, index) => {
          const source = sourceQuestions[index] || {};
          return {
            questionId: sanitizeText(item?.questionId || source?.id || `q${index + 1}`, 40),
            question: cleanLatexArtifacts(item?.question || source?.question || "", 900),
            answer: cleanLatexArtifacts(item?.answer || "", 2000),
            correctAnswer: cleanLatexArtifacts(source?.correctAnswer || "", 200),
            explanation: cleanLatexArtifacts(source?.explanation || "", 400),
            choices: Array.isArray(source?.choices) ? source.choices.map((choice) => cleanLatexArtifacts(choice, 200)).filter(Boolean).slice(0,4) : []
          };
        })
      : [];

    const aiResult = await gradeAssessmentWithAI(session, sourceQuestions.length ? sourceQuestions : sanitizedAnswers, sanitizedAnswers);
    const perQuestion = Array.isArray(aiResult?.perQuestion) ? aiResult.perQuestion : [];
    const detailed = sanitizedAnswers.map((item, index) => {
      const aiItem = perQuestion[index] || {};
      const normalizedUser = normalizeText(item.answer);
      const normalizedCorrect = normalizeText(item.correctAnswer);
      const directScore = normalizedUser && normalizedCorrect ? (normalizedUser === normalizedCorrect ? 2 : 0) : null;
      const safeScore = directScore !== null ? directScore : ([0,1,2].includes(aiItem.score) ? aiItem.score : scoreAnswer(item.answer));
      return {
        ...item,
        score: safeScore,
        feedback: sanitizeText(aiItem.feedback || item.explanation || "", 400),
        correctAnswer: item.correctAnswer
      };
    });

    const totalScore = detailed.reduce((sum, item) => sum + item.score, 0);
    const maxScore = sanitizedAnswers.length * 2;
    const weakPoints = (aiResult?.needsWork || []).slice(0, 6);
    const strengths = (aiResult?.strengths || []).slice(0, 6);
    const feedback = buildAssessmentFeedback(totalScore, maxScore);

    const entry = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      sessionCode: session.code,
      participantId: participant.id,
      participantName: participant.name,
      assessmentId: sanitizeText(assessmentId, 80) || participant.lastAssessmentId || "",
      totalScore,
      maxScore,
      feedbackLevel: feedback.level,
      feedbackSummary: feedback.summary,
      feedbackAdvice: sanitizeText(aiResult?.advice || feedback.advice, 600) || feedback.advice,
      weakPoints,
      strengths,
      answers: detailed,
      timestamp: nowIso(),
    };

    participant.lastAssessmentScore = totalScore;
    participant.lastAssessmentId = entry.assessmentId;

    const existingIndex = assessmentsStore.findIndex((item) => item.sessionId === session.id && item.participantId === participant.id);
    if (existingIndex >= 0) {
      assessmentsStore[existingIndex] = entry;
    } else {
      assessmentsStore.push(entry);
    }

    return res.json({
      score: totalScore,
      maxScore,
      level: feedback.level,
      summary: feedback.summary,
      advice: sanitizeText(aiResult?.advice || feedback.advice, 600) || feedback.advice,
      strengths,
      needsWork: weakPoints,
      perQuestion: detailed
    });
  } catch (error) {
    console.error("ERREUR SUBMIT ASSESSMENT :", error);
    return res.status(500).json({ error: "Impossible de corriger le bilan." });
  }
});


app.get("/api/sessions/:code/assessment/:participantId/export.xls", (req, res) => {
  const session = getSessionByCode(req.params.code);
  if (!session) {
    return res.status(404).send("Session introuvable.");
  }
  const participantId = String(req.params.participantId || "");
  const assessment = assessmentsStore.find((item) => item.sessionId === session.id && item.participantId === participantId);
  if (!assessment) {
    return res.status(404).send("Bilan introuvable.");
  }

  const noteSur5 = assessment.maxScore ? ((assessment.totalScore / assessment.maxScore) * 5).toFixed(1) : "0.0";
  const rows = (assessment.answers || []).map((item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${String(item.question || "").replace(/\n/g, "<br>")}</td>
      <td>${String(item.answer || "").replace(/\n/g, "<br>")}</td>
      <td>${String(item.correctAnswer || "").replace(/\n/g, "<br>")}</td>
      <td>${item.score ?? ""}/2</td>
      <td>${String(item.feedback || "").replace(/\n/g, "<br>")}</td>
    </tr>
  `).join("");

  const html = `
    <html>
      <head><meta charset="utf-8"></head>
      <body>
        <table border="1">
          <tr><th>Session</th><td>${session.code}</td></tr>
          <tr><th>Élève</th><td>${assessment.participantName}</td></tr>
          <tr><th>Score</th><td>${assessment.totalScore} / ${assessment.maxScore}</td></tr>
          <tr><th>Note sur 5</th><td>${noteSur5}</td></tr>
          <tr><th>Niveau</th><td>${assessment.feedbackLevel}</td></tr>
          <tr><th>Synthèse</th><td>${assessment.feedbackSummary}</td></tr>
          <tr><th>Conseil</th><td>${assessment.feedbackAdvice}</td></tr>
        </table>
        <br>
        <table border="1">
          <tr>
            <th>#</th>
            <th>Question</th>
            <th>Réponse élève</th>
            <th>Réponse attendue</th>
            <th>Score</th>
            <th>Feedback</th>
          </tr>
          ${rows}
        </table>
      </body>
    </html>
  `;
  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="bilan-${session.code}-${participantId}.xls"`);
  return res.send(html);
});

app.get("/api/sessions/:code/summary", (req, res) => {
  const summary = computeSessionSummary(req.params.code);
  if (!summary) {
    return res.status(404).json({ error: "Session introuvable." });
  }
  return res.json(summary);
});

app.get("/api/sessions/:code/export.csv", (req, res) => {
  const session = getSessionByCode(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "Session introuvable." });
  }

  const csv = buildSessionCsv(req.params.code);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="session-${session.code}.csv"`);
  return res.send(csv);
});

app.post("/api/sessions/:code/close", (req, res) => {
  const session = getSessionByCode(req.params.code);
  if (!session) {
    return res.status(404).json({ error: "Session introuvable." });
  }

  session.isActive = false;
  return res.json({ success: true, session: sanitizeSessionForClient(session) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
