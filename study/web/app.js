/* ==========================================================================
   Claude certification study app (vanilla JS, no dependencies)
   Loads exams/ + content/ JSON, routes 5 views by hash (#/<exam>/<view>), tracks cumulative progress in
   localStorage, and renders a readiness dashboard. Serve over http://localhost
   (see ../serve.py) so fetch() of the local JSON works.
   ========================================================================== */
(function () {
  "use strict";

  // Storage keys. Engine-level keys are shared by every exam; everything else
  // is namespaced per exam ("study-<slug>-…") and assigned in useExamKeys()
  // once boot has picked the exam.
  var THEME_KEY = "study-theme";
  var EXAM_KEY = "study-exam";
  // Progress is v2 since BL-050 (records keyed by pool IDs: q-0001); the v1
  // keys (exam-prefixed IDs: ccarf-q-1.1-001) are only read, to migrate.
  var PROGRESS_KEY, FC_PROGRESS_KEY, QUESTION_SET_KEY, FLASHCARD_SET_KEY, V1_PROGRESS_KEY, V1_FC_PROGRESS_KEY;
  var PROGRESS_VERSION = 2;
  function useExamKeys(slug) {
    PROGRESS_KEY = "study-" + slug + "-progress-v2";
    FC_PROGRESS_KEY = "study-" + slug + "-flashcard-progress-v2";
    V1_PROGRESS_KEY = "study-" + slug + "-progress-v1";
    V1_FC_PROGRESS_KEY = "study-" + slug + "-flashcard-progress-v1";
    QUESTION_SET_KEY = "study-" + slug + "-question-set";
    FLASHCARD_SET_KEY = "study-" + slug + "-flashcard-set";
  }
  var PASS_THRESHOLD = 72; // readiness pass cue; replaced at boot by the exam's config.pass_threshold

  var DATA = { meta: null, questions: [], flashcards: [], concepts: [], labs: [] };
  var view = document.getElementById("view");

  /* ---- tiny helpers ----------------------------------------------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function shuffleOptions(q) {
    // Real exam items don't always put the correct answer in the same spot,
    // so options are re-shuffled and relabeled (A, B, C, ...) each time a
    // question is presented. q.correct / q.rationale keep their original
    // keys untouched; origToDisplay/displayToOrig translate between them so
    // grading and rationale lookups stay correct regardless of the shuffle.
    var perm = shuffle(q.options);
    var letters = q.options.map(function (o) { return o.key; });
    var displayOptions = perm.map(function (o, i) { return { key: letters[i], text: o.text, orig: o.key }; });
    var origToDisplay = {}, displayToOrig = {};
    displayOptions.forEach(function (o) { origToDisplay[o.orig] = o.key; displayToOrig[o.key] = o.orig; });
    return { displayOptions: displayOptions, origToDisplay: origToDisplay, displayToOrig: displayToOrig };
  }
  function domainColor(id) { return "var(--d" + id + ")"; }
  function domainName(id) {
    var d = DATA.meta.domains.find(function (x) { return x.id === id; });
    return d ? d.name : "Domain " + id;
  }
  function taskTitle(tid) {
    var t = DATA.meta.task_statements.find(function (x) { return x.id === tid; });
    return t ? t.title : tid;
  }
  function taskLabs(tid) {
    var t = DATA.meta.task_statements.find(function (x) { return x.id === tid; });
    return t ? t.labs : [];
  }
  function labLink(lab) {
    return '<a href="../../labs/' + esc(lab) + '/" target="_blank" rel="noopener">' + esc(lab) + "</a>";
  }
  // Link text is a succinct, concept-tied label (not the raw video title, which
  // is often a channel/series name); the real title becomes the link's `title`
  // tooltip, standing in for alt text on a non-image link.
  function videosHtml(videos, concept) {
    return videos.map(function (v, i) {
      var label = (videos.length > 1 ? "Video " + (i + 1) + ": " : "Video: ") + concept.title;
      return '<a href="' + esc(v.url) + '" title="' + esc(v.title) + '" target="_blank" rel="noopener">' + esc(label) + "</a>";
    }).join("<br>");
  }

  /* ---- progress store --------------------------------------------------- */
  function loadProgress() {
    try {
      var p = JSON.parse(localStorage.getItem(PROGRESS_KEY));
      if (p && p.version === PROGRESS_VERSION && p.questions && p.sessions) return p;
    } catch (e) { /* fall through */ }
    return { version: PROGRESS_VERSION, questions: {}, sessions: [] };
  }
  function saveProgress(p) { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); }
  function recordAnswer(qid, correct) {
    var p = loadProgress();
    var q = p.questions[qid] || { seen: 0, correct: 0 };
    q.seen += 1;
    if (correct) q.correct += 1;
    q.last = correct ? "correct" : "wrong";
    q.ts = Date.now();
    p.questions[qid] = q;
    saveProgress(p);
  }
  function recordSession(total, correct) {
    var p = loadProgress();
    var r = computeReadiness(p);
    p.sessions.push({ ts: Date.now(), total: total, correct: correct, readiness: r.overall });
    saveProgress(p);
  }

  /* ---- flashcard self-graded progress (separate store; not part of exam readiness) ---- */
  function loadFcProgress() {
    try {
      var p = JSON.parse(localStorage.getItem(FC_PROGRESS_KEY));
      if (p && p.version === PROGRESS_VERSION && p.cards) return p;
    } catch (e) { /* fall through */ }
    return { version: PROGRESS_VERSION, cards: {} };
  }
  function saveFcProgress(p) { localStorage.setItem(FC_PROGRESS_KEY, JSON.stringify(p)); }
  function recordFlashcardAnswer(cid, gotIt) {
    var p = loadFcProgress();
    var c = p.cards[cid] || { seen: 0, correct: 0 };
    c.seen += 1;
    if (gotIt) c.correct += 1;
    c.last = gotIt ? "correct" : "wrong";
    c.ts = Date.now();
    p.cards[cid] = c;
    saveFcProgress(p);
  }

  /* ---- one-time migration from single-exam (pre-BL-045) storage --------- */
  // Before multi-exam support, CCAR-F progress lived under ccaf-study-* keys
  // with unprefixed item IDs (q-1.1-001, fc-1.1-001) and tier-name set IDs.
  // Copy it into the ccarf v1 namespace once — only while that key is still
  // empty — re-keying IDs to the prefixed form. Records saved under both forms
  // (possible from the interim multi-exam branch) are merged. Legacy keys are
  // left in place so an older checkout still sees its data. migrateStorage()
  // then carries v1 on to v2 (pool IDs).
  var LEGACY = {
    exam: "ccarf",
    theme: "ccaf-study-theme",
    progress: "ccaf-study-progress-v1",
    flashcards: "ccaf-study-flashcard-progress-v1",
    questionSet: "ccaf-study-question-set",
    flashcardSet: "ccaf-study-flashcard-set",
    questionSetIds: { standard: "questions-standard", intermediate: "questions-intermediate", hard: "questions-hard" },
    flashcardSetIds: { standard: "flashcards" },
  };
  function mergeRecord(a, b) {
    if (!a) return b;
    var newer = (b.ts || 0) > (a.ts || 0) ? b : a;
    return { seen: a.seen + b.seen, correct: a.correct + b.correct, last: newer.last, ts: newer.ts };
  }
  function prefixIds(records, slug) {
    var out = {};
    Object.keys(records || {}).forEach(function (id) {
      var key = id.indexOf(slug + "-") === 0 ? id : slug + "-" + id;
      out[key] = mergeRecord(out[key], records[id]);
    });
    return out;
  }
  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function migrateLegacyTheme() {
    var old = localStorage.getItem(LEGACY.theme);
    if (old && !localStorage.getItem(THEME_KEY)) localStorage.setItem(THEME_KEY, old);
  }
  function migrateLegacyStorage(slug) {
    if (slug !== LEGACY.exam) return;
    var p = readJSON(LEGACY.progress);
    if (p && p.questions && !localStorage.getItem(V1_PROGRESS_KEY) && !localStorage.getItem(PROGRESS_KEY)) {
      localStorage.setItem(V1_PROGRESS_KEY, JSON.stringify({ version: 1, questions: prefixIds(p.questions, slug), sessions: p.sessions || [] }));
    }
    var fc = readJSON(LEGACY.flashcards);
    if (fc && fc.cards && !localStorage.getItem(V1_FC_PROGRESS_KEY) && !localStorage.getItem(FC_PROGRESS_KEY)) {
      localStorage.setItem(V1_FC_PROGRESS_KEY, JSON.stringify({ version: 1, cards: prefixIds(fc.cards, slug) }));
    }
    [[LEGACY.questionSet, QUESTION_SET_KEY, LEGACY.questionSetIds],
     [LEGACY.flashcardSet, FLASHCARD_SET_KEY, LEGACY.flashcardSetIds]].forEach(function (m) {
      var old = localStorage.getItem(m[0]);
      if (old && !localStorage.getItem(m[1])) localStorage.setItem(m[1], m[2][old] || old);
    });
  }

  /* ---- one-time migration to pool IDs (BL-050) ---------------------------- */
  // Content moved into an exam-neutral pool: ccarf-q-1.1-001 became q-0001 and
  // set ids lost their exam prefix (ccarf-questions-hard → questions-hard), per
  // the committed migrations/pool-ids-2026-10.json — fetched only when needed.
  // v1 progress is re-keyed into the v2 keys once (only while they're empty);
  // unmapped ids are kept, records landing on one id are merged, and the v1
  // keys are left in place.
  var poolIds = null;
  function fetchPoolIds() {
    return poolIds || (poolIds = fetchJSON("../migrations/pool-ids-2026-10.json"));
  }
  function rekeyRecords(records, ids) {
    var out = {};
    Object.keys(records || {}).forEach(function (id) {
      var key = ids[id] || id;
      out[key] = mergeRecord(out[key], records[id]);
    });
    return out;
  }
  function migrateStorage(slug, registry) {
    migrateLegacyStorage(slug);
    var p = !localStorage.getItem(PROGRESS_KEY) && readJSON(V1_PROGRESS_KEY);
    var fc = !localStorage.getItem(FC_PROGRESS_KEY) && readJSON(V1_FC_PROGRESS_KEY);
    var setKeys = [QUESTION_SET_KEY, FLASHCARD_SET_KEY].filter(function (k) {
      var v = localStorage.getItem(k);
      return v && !registry[v]; // names a component that no longer exists
    });
    if (!(p && p.questions) && !(fc && fc.cards) && !setKeys.length) return Promise.resolve();
    return fetchPoolIds().then(function (mig) {
      if (p && p.questions) saveProgress({ version: PROGRESS_VERSION, questions: rekeyRecords(p.questions, mig.questions), sessions: p.sessions || [] });
      if (fc && fc.cards) saveFcProgress({ version: PROGRESS_VERSION, cards: rekeyRecords(fc.cards, mig.flashcards) });
      setKeys.forEach(function (k) {
        var v = localStorage.getItem(k);
        if (mig.components[v]) localStorage.setItem(k, mig.components[v]);
      });
    });
  }

  /* ---- readiness math --------------------------------------------------- */
  function computeReadiness(p) {
    var byTask = {}; // tid -> {seen, correct, total}
    DATA.meta.task_statements.forEach(function (t) { byTask[t.id] = { seen: 0, correct: 0, total: 0 }; });
    DATA.questions.forEach(function (q) {
      var t = byTask[q.task_statement]; if (!t) return;
      t.total += 1;
      var rec = p.questions[q.id];
      if (rec && rec.seen > 0) { t.seen += 1; t.correct += rec.correct > 0 ? 1 : 0; }
    });
    var domains = DATA.meta.domains.map(function (d) {
      var seen = 0, correct = 0, total = 0;
      DATA.meta.task_statements.forEach(function (t) {
        if (t.domain !== d.id) return;
        seen += byTask[t.id].seen; correct += byTask[t.id].correct; total += byTask[t.id].total;
      });
      return {
        id: d.id, name: d.name, weight: d.weight, color: domainColor(d.id),
        mastery: seen ? Math.round((correct / seen) * 100) : 0,
        answered: seen, total: total
      };
    });
    // Overall = domain mastery weighted by exam weights (unanswered domain = 0).
    var overall = Math.round(domains.reduce(function (s, d) { return s + d.weight * d.mastery; }, 0) / 100);
    var tasks = DATA.meta.task_statements.map(function (t) {
      var b = byTask[t.id];
      return {
        id: t.id, title: t.title, labs: t.labs, domain: t.domain,
        mastery: b.seen ? Math.round((b.correct / b.seen) * 100) : 0,
        answered: b.seen, total: b.total
      };
    });
    return { overall: overall, domains: domains, tasks: tasks };
  }
  function readinessColor(pct) {
    if (pct >= PASS_THRESHOLD) return "var(--good)";
    if (pct >= 50) return "var(--warning)";
    return "var(--critical)";
  }

  /* ---- router ----------------------------------------------------------- */
  // Routes carry the exam: #/<exam>/<view> (e.g. #/ccarf/quiz). A bare legacy
  // route (#/quiz) or an unknown view is rewritten in place to the active exam
  // + a real view. A route naming a different exam saves it and reloads, so
  // that exam's data and storage namespace boot cleanly.
  var ROUTES = { concepts: renderConcepts, flashcards: renderFlashcards, labs: renderLabs, quiz: renderQuiz, readiness: renderReadiness };
  var EXAM = null, EXAM_SLUGS = []; // active exam slug + all slugs; set at boot
  function parseHash() {
    var parts = (location.hash || "").replace(/^#\/?/, "").split("/");
    if (EXAM_SLUGS.indexOf(parts[0]) >= 0) return { exam: parts[0], view: parts[1] || "" };
    return { exam: null, view: parts[0] || "" };
  }
  function viewHref(name, slug) { return "#/" + (slug || EXAM) + "/" + name; }
  function currentRoute() {
    var v = parseHash().view;
    return ROUTES[v] ? v : "concepts";
  }
  function router() {
    var r = parseHash();
    if (r.exam && r.exam !== EXAM) {
      localStorage.setItem(EXAM_KEY, r.exam);
      location.reload();
      return;
    }
    var name = currentRoute();
    if (r.exam !== EXAM || r.view !== name) history.replaceState(null, "", viewHref(name));
    document.querySelectorAll(".tab").forEach(function (t) {
      var v = t.getAttribute("data-view");
      t.setAttribute("href", viewHref(v));
      if (v === name) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    // Switching exams keeps the current view.
    document.querySelectorAll(".exam-switch__opt").forEach(function (a) {
      a.setAttribute("href", viewHref(name, a.getAttribute("data-exam")));
    });
    view.innerHTML = "";
    ROUTES[name]();
    view.focus();
  }

  /* ---- shared control builders ----------------------------------------- */
  // Content-aware: only list domains/tasks that actually have items, so a user
  // never selects an option that yields zero results. `items` defaults to the
  // question bank (quiz); flashcards/concepts pass their own datasets.
  function domainOptions(sel, items) {
    var have = {};
    (items || DATA.questions).forEach(function (x) { have[x.domain] = true; });
    var o = '<option value="all">All domains</option>';
    DATA.meta.domains.forEach(function (d) {
      if (!have[d.id]) return;
      o += '<option value="' + d.id + '"' + (String(sel) === String(d.id) ? " selected" : "") + ">D" + d.id + " · " + esc(d.name) + "</option>";
    });
    return o;
  }
  function taskOptions(domainSel, taskSel, items) {
    var have = {};
    (items || DATA.questions).forEach(function (q) { have[q.task_statement] = true; });
    var o = '<option value="all">All task statements</option>';
    DATA.meta.task_statements.forEach(function (t) {
      if (!have[t.id]) return;
      if (domainSel !== "all" && String(t.domain) !== String(domainSel)) return;
      o += '<option value="' + t.id + '"' + (t.id === taskSel ? " selected" : "") + ">" + esc(t.id) + " · " + esc(t.title) + "</option>";
    });
    return o;
  }

  /* ======================================================================
     QUIZ
     ==================================================================== */
  var quiz = null; // {pool, idx, score, answered}

  function renderQuiz() {
    if (quiz && quiz.active) { renderQuizQuestion(); return; }
    view.innerHTML =
      '<div class="view-head"><h1>Practice Quiz</h1><p>Scenario multiple-choice, exam-style. Pick a scope, then see the correct answer and why each distractor is wrong.</p></div>' +
      '<div class="card">' +
        '<div class="row">' +
          '<label class="field">Question set<select id="q-set">' + setOptions("questions", DATA.currentQuestionSet) + "</select></label>" +
          '<label class="field">Domain<select id="q-domain">' + domainOptions("all") + "</select></label>" +
          '<label class="field">Task statement<select id="q-task">' + taskOptions("all", "all") + "</select></label>" +
          '<label class="field">Length<select id="q-len"><option value="10">10 questions</option><option value="20">20 questions</option><option value="0">All matching</option></select></label>' +
        "</div>" +
        '<div class="row" style="margin-top:.7rem">' +
          '<label class="row" style="gap:.4rem;font-size:.85rem;color:var(--ink-2)"><input type="checkbox" id="q-missed"> Only unseen or previously missed</label>' +
          '<span class="spacer"></span>' +
          '<span class="pill" id="q-count"></span>' +
          '<button class="btn btn--primary" id="q-start">Start Quiz →</button>' +
        "</div>" +
      "</div>";

    document.getElementById("q-set").addEventListener("change", function (e) {
      selectQuestionSet(e.target.value); renderQuiz();
    });
    var dSel = document.getElementById("q-domain");
    var tSel = document.getElementById("q-task");
    dSel.addEventListener("change", function () {
      tSel.innerHTML = taskOptions(dSel.value, "all");
      updateCount();
    });
    tSel.addEventListener("change", updateCount);
    document.getElementById("q-missed").addEventListener("change", updateCount);
    document.getElementById("q-start").addEventListener("click", startQuiz);
    updateCount();

    function updateCount() {
      var n = buildPool().length;
      document.getElementById("q-count").textContent = n + " available";
      document.getElementById("q-start").disabled = n === 0;
    }
  }

  function buildPool() {
    var d = document.getElementById("q-domain").value;
    var t = document.getElementById("q-task").value;
    var missed = document.getElementById("q-missed").checked;
    var p = loadProgress();
    return DATA.questions.filter(function (q) {
      if (d !== "all" && String(q.domain) !== String(d)) return false;
      if (t !== "all" && q.task_statement !== t) return false;
      if (missed) {
        var rec = p.questions[q.id];
        if (rec && rec.correct > 0) return false; // answered correctly before → skip
      }
      return true;
    });
  }

  function startQuiz() {
    var len = parseInt(document.getElementById("q-len").value, 10);
    var pool = shuffle(buildPool());
    if (len > 0) pool = pool.slice(0, len);
    quiz = { pool: pool, idx: 0, score: 0, answered: false, active: true };
    renderQuizQuestion();
  }

  function renderQuizQuestion() {
    var q = quiz.pool[quiz.idx];
    if (!q) { renderQuizSummary(); return; }
    if (quiz.mapIdx !== quiz.idx) { quiz.map = shuffleOptions(q); quiz.mapIdx = quiz.idx; }
    var pct = Math.round((quiz.idx / quiz.pool.length) * 100);
    var isMulti = Array.isArray(q.correct);
    var opts = quiz.map.displayOptions.map(function (o) {
      return '<button class="option" data-key="' + o.key + '">' +
        '<span class="option__key">' + o.key + "</span>" +
        '<span class="option__text">' + esc(o.text) + "</span></button>";
    }).join("");

    view.innerHTML =
      '<div class="quiz-meta"><span class="pill">D' + q.domain + " · " + esc(q.task_statement) +
        (q.difficulty != null ? ' <span class="pill__nocaps">(Difficulty: ' + q.difficulty + "/10)</span>" : "") + "</span>" +
        (isMulti ? '<span class="pill">Select ' + q.correct.length + "</span>" : "") +
        '<div class="progressbar"><span id="q-bar" style="width:' + pct + '%"></span></div>' +
        '<span id="q-score"></span></div>' +
      '<div class="card">' +
        (q.scenario ? '<div class="scenario">' + esc(q.scenario) + "</div>" : "") +
        '<p class="stem">' + esc(q.stem) + "</p>" +
        '<div class="options" id="opts">' + opts + "</div>" +
        '<div class="rationale" id="rat" aria-live="polite"></div>' +
        '<div class="row" style="margin-top:1rem">' +
          '<button class="btn btn--ghost" id="q-quit">End Quiz</button>' +
          '<span class="spacer"></span>' +
          (isMulti ? '<button class="btn btn--primary" id="q-submit" disabled>Submit (0/' + q.correct.length + ")</button>" : "") +
          '<button class="btn btn--primary" id="q-next" disabled>Next →</button>' +
        "</div>" +
      "</div>";

    quiz.answered = false;
    updateQuizMeta();
    if (isMulti) {
      quiz.selected = [];
      document.getElementById("opts").addEventListener("click", function (e) {
        if (quiz.answered) return;
        var btn = e.target.closest(".option");
        if (!btn) return;
        var key = btn.getAttribute("data-key");
        var at = quiz.selected.indexOf(key);
        if (at >= 0) { quiz.selected.splice(at, 1); btn.classList.remove("is-selected"); }
        else { quiz.selected.push(key); btn.classList.add("is-selected"); }
        var submitBtn = document.getElementById("q-submit");
        submitBtn.textContent = "Submit (" + quiz.selected.length + "/" + q.correct.length + ")";
        submitBtn.disabled = quiz.selected.length !== q.correct.length;
      });
      document.getElementById("q-submit").addEventListener("click", function () {
        answerQuiz(q, quiz.selected);
      });
    } else {
      document.getElementById("opts").addEventListener("click", function (e) {
        var btn = e.target.closest(".option");
        if (btn) answerQuiz(q, btn.getAttribute("data-key"));
      });
    }
    document.getElementById("q-next").addEventListener("click", function () {
      quiz.idx += 1; renderQuizQuestion();
    });
    document.getElementById("q-quit").addEventListener("click", function () {
      quiz.pool = quiz.pool.slice(0, quiz.idx + (quiz.answered ? 1 : 0)); renderQuizSummary();
    });
  }

  // Same 90/75/60 breakpoints as the CLI/TUI quiz's accuracy_color().
  function accuracyClass(pct) {
    return pct >= 90 ? "acc-green" : pct >= 75 ? "acc-yellow" : pct >= 60 ? "acc-orange" : "acc-red";
  }
  // Refresh the "Q n/N · Score X (Y%)" text and the bar's accuracy color.
  function updateQuizMeta() {
    var answered = quiz.idx + (quiz.answered ? 1 : 0);
    var pct = answered ? Math.round((quiz.score / answered) * 100) : null;
    document.getElementById("q-score").textContent = "Q " + (quiz.idx + 1) + "/" + quiz.pool.length +
      " · Score " + quiz.score + (pct === null ? "" : " (" + pct + "%)");
    var bar = document.getElementById("q-bar");
    bar.style.width = Math.round((answered / quiz.pool.length) * 100) + "%";
    bar.className = pct === null ? "" : accuracyClass(100 * quiz.score / answered);
  }

  function answerQuiz(q, key) {
    if (quiz.answered) return;
    quiz.answered = true;
    var map = quiz.map;
    var isMulti = Array.isArray(q.correct);
    var correctOrigSet = isMulti ? q.correct.slice().sort() : null;
    var chosenOrigSet = isMulti ? key.map(function (k) { return map.displayToOrig[k]; }).sort() : null;
    var correct = isMulti
      ? (chosenOrigSet.length === correctOrigSet.length && chosenOrigSet.every(function (k, i) { return k === correctOrigSet[i]; }))
      : map.displayToOrig[key] === q.correct;
    if (correct) quiz.score += 1;
    recordAnswer(q.id, correct);
    updateQuizMeta();

    document.querySelectorAll("#opts .option").forEach(function (btn) {
      var dKey = btn.getAttribute("data-key");
      var oKey = map.displayToOrig[dKey];
      btn.setAttribute("disabled", "true");
      if (isMulti) {
        if (correctOrigSet.indexOf(oKey) >= 0) btn.classList.add("is-correct");
        else if (chosenOrigSet.indexOf(oKey) >= 0) btn.classList.add("is-wrong");
      } else {
        if (oKey === q.correct) btn.classList.add("is-correct");
        else if (dKey === key) btn.classList.add("is-wrong");
      }
    });

    var distractors = Object.keys(q.rationale.distractors).sort(function (a, b) {
      return map.origToDisplay[a] < map.origToDisplay[b] ? -1 : 1;
    }).map(function (oKey) {
      var dKey = map.origToDisplay[oKey];
      return '<div class="rationale__item"><b>' + dKey + " —</b> " + esc(q.rationale.distractors[oKey]) + "</div>";
    }).join("");
    var answerLabel = isMulti
      ? correctOrigSet.map(function (k) { return map.origToDisplay[k]; }).sort().join(", ")
      : map.origToDisplay[q.correct];
    var rat = document.getElementById("rat");
    rat.innerHTML =
      '<h3>' + (correct ? "✓ Correct" : "✕ Not quite") + " — answer" + (isMulti ? "s " : " ") + answerLabel + "</h3>" +
      '<div class="rationale__correct">' + esc(q.rationale.correct) + "</div>" +
      '<h3>Why the others are wrong</h3><div class="rationale__list">' + distractors + "</div>" +
      (q.lab ? '<p class="muted" style="margin-top:.7rem;font-size:.85rem">Practice this hands-on: ' + labLink(q.lab) + "</p>" : "");
    rat.classList.add("show");
    document.getElementById("q-next").disabled = false;
    document.getElementById("q-next").textContent = quiz.idx + 1 >= quiz.pool.length ? "See results →" : "Next →";
  }

  function renderQuizSummary() {
    var total = quiz.pool.length;
    var score = quiz.score;
    if (total > 0) recordSession(total, score);
    quiz.active = false;
    var pct = total ? Math.round((score / total) * 100) : 0;
    view.innerHTML =
      '<div class="view-head"><h1>Quiz Complete</h1></div>' +
      '<div class="card" style="text-align:center">' +
        '<div class="gauge" style="justify-content:center">' +
          '<div class="gauge__ring-wrap"><div class="gauge__ring" style="--p:' + pct + ';--gauge-color:' + readinessColor(pct) + '"></div>' +
          '<span class="gauge__pct">' + pct + "%</span></div>" +
          '<div style="text-align:left"><div class="gauge__num">' + score + "/" + total + "</div>" +
          '<div class="muted">questions correct this set</div></div></div>' +
        '<div class="row" style="justify-content:center;margin-top:1.2rem">' +
          '<button class="btn btn--primary" id="q-again">New Quiz</button>' +
          '<a class="btn" href="' + viewHref("readiness") + '">View Readiness →</a>' +
        "</div>" +
      "</div>";
    document.getElementById("q-again").addEventListener("click", function () { quiz = null; renderQuiz(); });
  }

  /* ======================================================================
     FLASHCARDS
     ==================================================================== */
  var fc = null; // {pool, idx, flipped}

  function renderFlashcards() {
    if (!fc) fc = { pool: shuffle(DATA.flashcards), idx: 0, flipped: false, domain: "all", task: "all", missedOnly: false };
    view.innerHTML =
      '<div class="view-head"><h1>Flashcards</h1><p>Fact recall for the exam appendix — CLI flags, <code>tool_choice</code> values, batch limits, and more. Click a card to flip, then grade yourself.</p></div>' +
      '<div class="card"><div class="row">' +
        '<label class="field">Flashcard set<select id="fc-set">' + setOptions("flashcards", DATA.currentFlashcardSet) + "</select></label>" +
        '<label class="field">Domain<select id="fc-domain">' + domainOptions(fc.domain, DATA.flashcards) + "</select></label>" +
        '<label class="field">Task statement<select id="fc-task">' + taskOptions(fc.domain, fc.task, DATA.flashcards) + "</select></label>" +
        '<span class="spacer"></span>' +
        '<label class="row" style="gap:.4rem;font-size:.85rem;color:var(--ink-2)"><input type="checkbox" id="fc-missed"' + (fc.missedOnly ? " checked" : "") + '> Only previously missed</label>' +
        '<button class="btn" id="fc-shuffle">⇄ Shuffle</button>' +
      "</div></div>";

    document.getElementById("fc-set").addEventListener("change", function (e) {
      selectFlashcardSet(e.target.value); fc = null; renderFlashcards();
    });
    document.getElementById("fc-missed").addEventListener("change", function (e) {
      fc.missedOnly = e.target.checked;
      applyFcFilter();
    });

    if (fc.pool.length === 0) {
      view.insertAdjacentHTML("beforeend", emptyState("🗂", fc.missedOnly ? "No previously-missed cards match this filter." : "No flashcards match this filter yet."));
      wireFcDomain(); return;
    }
    fc.idx = Math.min(fc.idx, fc.pool.length - 1);
    var card = fc.pool[fc.idx];
    view.insertAdjacentHTML("beforeend",
      '<button class="flashcard' + (fc.flipped ? " flipped" : "") + '" id="fc-card" aria-label="Flashcard, click to flip">' +
        '<div class="flashcard__inner">' +
          '<div class="flashcard__face flashcard__face--front"><div class="flashcard__label">' + esc(card.task_statement) + " · " + esc(domainName(card.domain)) + '</div><div class="flashcard__body">' + esc(card.front) + '</div><div class="flashcard__hint">Reveal Answer</div></div>' +
          '<div class="flashcard__face flashcard__face--back"><div class="flashcard__label">Answer</div><div class="flashcard__body">' + esc(card.back) + '</div><div class="flashcard__hint">Flip Back</div></div>' +
        "</div></button>" +
      '<div class="row" id="fc-grade-row" style="margin-top:.8rem;justify-content:center;gap:.6rem;display:' + (fc.flipped ? "flex" : "none") + '">' +
        '<button class="btn btn--bad" id="fc-missed-it">✗ Missed It</button>' +
        '<button class="btn btn--good" id="fc-got-it">✓ Got It</button>' +
      "</div>" +
      '<div class="row" style="margin-top:1rem"><button class="btn" id="fc-prev">← Prev</button>' +
        '<span class="spacer"></span><span class="pill">' + (fc.idx + 1) + " / " + fc.pool.length + '</span><span class="spacer"></span>' +
        '<button class="btn" id="fc-next">Next →</button></div>');

    document.getElementById("fc-card").addEventListener("click", function () {
      fc.flipped = !fc.flipped;
      document.getElementById("fc-card").classList.toggle("flipped");
      document.getElementById("fc-grade-row").style.display = fc.flipped ? "flex" : "none";
    });
    document.getElementById("fc-prev").addEventListener("click", function () {
      fc.idx = (fc.idx - 1 + fc.pool.length) % fc.pool.length; fc.flipped = false; renderFlashcards();
    });
    document.getElementById("fc-next").addEventListener("click", function () {
      fc.idx = (fc.idx + 1) % fc.pool.length; fc.flipped = false; renderFlashcards();
    });
    document.getElementById("fc-shuffle").addEventListener("click", function () {
      fc.pool = shuffle(fc.pool); fc.idx = 0; fc.flipped = false; renderFlashcards();
    });
    document.getElementById("fc-got-it").addEventListener("click", function () { gradeCard(true); });
    document.getElementById("fc-missed-it").addEventListener("click", function () { gradeCard(false); });
    wireFcDomain();

    function gradeCard(gotIt) {
      recordFlashcardAnswer(card.id, gotIt);
      fc.idx = (fc.idx + 1) % fc.pool.length;
      fc.flipped = false;
      renderFlashcards();
    }

    function applyFcFilter() {
      var progress = loadFcProgress();
      fc.pool = shuffle(DATA.flashcards.filter(function (c) {
        if (fc.domain !== "all" && String(c.domain) !== String(fc.domain)) return false;
        if (fc.task !== "all" && c.task_statement !== fc.task) return false;
        if (fc.missedOnly) {
          var rec = progress.cards[c.id];
          if (!rec || rec.last !== "wrong") return false;
        }
        return true;
      }));
      fc.idx = 0; fc.flipped = false; renderFlashcards();
    }
    function wireFcDomain() {
      document.getElementById("fc-domain").addEventListener("change", function (e) {
        fc.domain = e.target.value;
        fc.task = "all";
        applyFcFilter();
      });
      document.getElementById("fc-task").addEventListener("change", function (e) {
        fc.task = e.target.value;
        applyFcFilter();
      });
    }
  }

  /* ======================================================================
     CONCEPTS
     ==================================================================== */
  function renderConcepts() {
    view.innerHTML =
      '<div class="view-head"><h1>Concept Explainers</h1><p>One per exam task statement: the idea, why it matters, the common trap, and the lab to practice it.</p></div>' +
      '<div class="card"><div class="row">' +
        '<select id="c-domain" aria-label="Filter by domain">' + domainOptions("all", DATA.concepts) + "</select>" +
        '<span class="spacer"></span>' +
        '<input type="search" id="c-search" class="search-input" placeholder="Search concepts…" aria-label="Search concepts">' +
        '<button class="btn" id="c-expand">Expand All</button>' +
        '<button class="btn" id="c-collapse">Collapse All</button>' +
      "</div></div>" +
      '<div id="c-list"></div>' +
      '<div id="c-noresults" class="empty" style="display:none">No concepts match your search.</div>';
    var sel = document.getElementById("c-domain");
    var search = document.getElementById("c-search");
    sel.addEventListener("change", function () { paint(sel.value); });
    search.addEventListener("input", applyFilter);
    function setAll(open) {
      document.querySelectorAll("#c-list details.concept").forEach(function (d) { d.open = open; });
    }
    document.getElementById("c-expand").addEventListener("click", function () { setAll(true); });
    document.getElementById("c-collapse").addEventListener("click", function () { setAll(false); });
    // Live text filter: show only concepts whose searchable text matches; hide
    // empty domain sections; surface a no-results note.
    function applyFilter() {
      var q = search.value.trim().toLowerCase();
      var any = false;
      document.querySelectorAll("#c-list .concept-domain").forEach(function (section) {
        var shown = 0;
        section.querySelectorAll("details.concept").forEach(function (d) {
          var ok = !q || (d.getAttribute("data-search") || "").indexOf(q) >= 0;
          d.style.display = ok ? "" : "none";
          if (ok) shown++;
          // A match hidden inside a collapsed body is invisible even though it's
          // highlighted, so auto-reveal matches while searching. Only close what
          // search itself opened, so this never overrides a manual expand/collapse.
          if (q && ok) {
            if (!d.open) { d.open = true; d.dataset.searchOpened = "1"; }
          } else if (d.dataset.searchOpened === "1") {
            d.open = false;
            delete d.dataset.searchOpened;
          }
        });
        section.style.display = shown ? "" : "none";
        if (shown) any = true;
      });
      document.getElementById("c-noresults").style.display = (q && !any) ? "" : "none";
      highlightMatches(q);
    }
    // Highlight query matches in place via the CSS Custom Highlight API — no DOM
    // mutation (so it never disturbs code spans), trivially cleared, and a no-op
    // where unsupported. Highlights in a collapsed body only show once expanded.
    function highlightMatches(q) {
      if (!window.CSS || !CSS.highlights) return;
      CSS.highlights.delete("concept-search");
      var root = document.getElementById("c-list");
      if (!q || !root) return;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var hl = new Highlight();
      var node, found = false;
      while ((node = walker.nextNode())) {
        var text = node.nodeValue.toLowerCase();
        var idx = text.indexOf(q);
        while (idx !== -1) {
          var r = document.createRange();
          r.setStart(node, idx);
          r.setEnd(node, idx + q.length);
          hl.add(r);
          found = true;
          idx = text.indexOf(q, idx + q.length);
        }
      }
      if (found) CSS.highlights.set("concept-search", hl);
    }
    paint("all");

    function paint(dsel) {
      var list = document.getElementById("c-list");
      if (DATA.concepts.length === 0) { list.innerHTML = emptyState("📘", "No concept explainers authored yet."); return; }
      var html = "";
      DATA.meta.domains.forEach(function (d) {
        if (dsel !== "all" && String(d.id) !== String(dsel)) return;
        var items = DATA.concepts.filter(function (c) { return c.domain === d.id; })
          .sort(function (a, b) { return a.task_statement.localeCompare(b.task_statement, undefined, { numeric: true }); });
        if (items.length === 0) return;
        html += '<section class="concept-domain"><h2><span class="dot" style="background:' + domainColor(d.id) + '"></span>D' + d.id + " · " + esc(d.name) + "</h2>";
        items.forEach(function (c) {
          var searchText = (c.task_statement + " " + c.title + " " + c.concept + " " +
            c.why_it_matters + " " + c.common_trap).toLowerCase();
          html +=
            '<details class="concept" data-search="' + esc(searchText) + '"><summary><span class="tsid">' + esc(c.task_statement) + "</span> " + esc(c.title) + "</summary>" +
            '<div class="concept__body"><dl>' +
              "<dt>Concept</dt><dd>" + esc(c.concept) + "</dd>" +
              "<dt>Why it matters</dt><dd>" + esc(c.why_it_matters) + "</dd>" +
              "<dt>Common trap</dt><dd>" + esc(c.common_trap) + "</dd>" +
              (c.code_samples && c.code_samples.length ? "<dt>Code</dt><dd>" + codeSamplesHtml(c.code_samples) + "</dd>" : "") +
              (c.videos && c.videos.length ? "<dt>Videos</dt><dd>" + videosHtml(c.videos, c) + "</dd>" : "") +
              (c.lab ? "<dt>Practice</dt><dd>" + labLink(c.lab) + "</dd>" : "") +
            "</dl></div></details>";
        });
        html += "</section>";
      });
      list.innerHTML = html || emptyState("📘", "No concept explainers for this domain yet.");
      applyFilter();
    }
  }

  /* ======================================================================
     LABS  (README/SOLUTION HTML is pre-rendered at build time by
     tools/build_labs.py from our own trusted lab Markdown, with <script>
     stripped — injected as HTML so the browser needs no Markdown parser.)
     ==================================================================== */
  var labView = { slug: null };

  function pad2(n) { return ("0" + n).slice(-2); }

  function renderLabs() {
    if (labView.slug) { renderLabDetail(); return; }
    if (!DATA.labs.length) { view.innerHTML = emptyState("🧪", "No labs available."); return; }
    var rows = DATA.labs.map(function (l) {
      return '<button class="lab-row" data-slug="' + esc(l.slug) + '">' +
        '<span class="lab-num">' + pad2(l.number) + "</span>" +
        '<span class="lab-row__title">' + esc(l.title.replace(/^Lab\s+\d+:\s*/i, "")) + "</span>" +
        '<span class="lab-row__slug">' + esc(l.slug) + "</span></button>";
    }).join("");
    view.innerHTML =
      '<div class="view-head"><h1>Labs</h1><p>The 25 hands-on labs, browsable here. Open one to read its instructions; reveal the solution when you want to check your work.</p></div>' +
      '<div class="lab-list">' + rows + "</div>";
    document.getElementById("view").querySelector(".lab-list").addEventListener("click", function (e) {
      var btn = e.target.closest(".lab-row");
      if (btn) { labView.slug = btn.getAttribute("data-slug"); renderLabs(); window.scrollTo(0, 0); }
    });
  }

  function renderLabDetail() {
    var l = DATA.labs.find(function (x) { return x.slug === labView.slug; });
    if (!l) { labView.slug = null; renderLabs(); return; }
    view.innerHTML =
      '<div class="row" style="margin-bottom:1rem"><button class="btn" id="lab-back">← All labs</button>' +
        '<span class="spacer"></span><span class="pill">lab ' + pad2(l.number) + "</span></div>" +
      '<div class="view-head"><h1>' + esc(l.title.replace(/^Lab\s+\d+:\s*/i, "")) + "</h1></div>" +
      '<div class="card"><div class="lab-doc">' + l.readme_html + "</div></div>" +
      (l.solution_html
        ? '<details class="card lab-solution"><summary>Show solution</summary><div class="lab-doc">' + l.solution_html + "</div></details>"
        : "");
    document.getElementById("lab-back").addEventListener("click", function () {
      labView.slug = null; renderLabs(); window.scrollTo(0, 0);
    });
  }

  /* ======================================================================
     READINESS
     ==================================================================== */
  function renderReadiness() {
    var p = loadProgress();
    var r = computeReadiness(p);
    // The tile counts the selected set only, like the gauge and bars below it;
    // records from other tiers (or for items no longer mapped) don't count.
    var answered = DATA.questions.filter(function (q) { var rec = p.questions[q.id]; return rec && rec.seen > 0; }).length;
    var totalQ = DATA.questions.length;
    var setEntry = DATA.sets.questions.find(function (e) { return e.id === DATA.currentQuestionSet; });

    view.innerHTML = '<div class="view-head"><h1>Readiness</h1><p>Cumulative, weighted by the exam’s domain weights. Progress is saved in this browser.</p></div>';

    if (Object.keys(p.questions).length === 0) {
      view.insertAdjacentHTML("beforeend", emptyState("📊", "Take a quiz to start building your readiness picture.") +
        '<div class="row" style="justify-content:center;margin-bottom:2rem"><a class="btn btn--primary" href="' + viewHref("quiz") + '">Start a Quiz →</a></div>');
      renderProgressTools(p);
      return;
    }

    // Overall gauge + stat tiles
    view.insertAdjacentHTML("beforeend",
      '<div class="card"><div class="gauge">' +
        '<div class="gauge__ring-wrap"><div class="gauge__ring" style="--p:' + r.overall + ';--gauge-color:' + readinessColor(r.overall) + '"></div><span class="gauge__pct">' + r.overall + "%</span></div>" +
        '<div><div class="gauge__num">' + r.overall + '%<span style="font-size:1rem;color:var(--ink-muted);font-weight:500"> readiness</span></div>' +
        '<div class="muted">' + (r.overall >= PASS_THRESHOLD ? "At or above the ~" + PASS_THRESHOLD + "% pass line. Keep reinforcing weak areas." : "Below the ~" + PASS_THRESHOLD + "% pass line — focus on the weak domains below.") + "</div></div>" +
      "</div>" +
      '<div class="stat-tiles" style="margin-top:1rem">' +
        tile(answered + "/" + totalQ, (setEntry ? setEntry.label + " " : "") + "questions attempted") +
        tile(sessionCount(p) + "", "quiz sessions") +
        tile(bestStreak(p) + "", "best session score %") +
        tile(lastStudied(p), "last studied") +
      "</div></div>");

    // Per-domain mastery bars
    var bars = r.domains.map(function (d) {
      return barRow(
        '<span class="dot" style="background:' + d.color + '"></span>D' + d.id + " · " + esc(d.name),
        d.answered ? d.mastery + "%" : "—",
        d.answered ? d.mastery : 0, d.color,
        d.answered ? d.answered + "/" + d.total + " answered · " + d.weight + "% of exam" : "not attempted yet · " + d.weight + "% of exam"
      );
    }).join("");
    view.insertAdjacentHTML("beforeend", '<div class="card"><h2 style="margin:.1rem 0 .8rem;font-size:1.05rem">Mastery by Domain</h2><div class="bars">' + bars + "</div></div>");

    // Readiness over time sparkline
    view.insertAdjacentHTML("beforeend",
      '<div class="card"><h2 style="margin:.1rem 0 .3rem;font-size:1.05rem">Readiness Over Time</h2>' +
      '<p class="muted" style="margin:.1rem 0 .6rem;font-size:.85rem">Overall readiness after each quiz session.</p>' + sparkline(p) + "</div>");

    // Weak areas
    var weak = r.tasks.filter(function (t) { return t.answered > 0 && t.mastery < PASS_THRESHOLD; })
      .sort(function (a, b) { return a.mastery - b.mastery; }).slice(0, 8);
    if (weak.length) {
      var items = weak.map(function (t) {
        var labs = t.labs.map(labLink).join(", ");
        return "<li><span class=\"pill\" style=\"background:" + domainColor(t.domain) + ";color:#fff\">" + esc(t.id) + "</span>" +
          '<span style="flex:1">' + esc(t.title) + ' <span class="muted">(' + t.mastery + "%, " + t.answered + " seen)</span></span>" +
          '<span class="muted" style="font-size:.82rem">' + (labs || "") + "</span></li>";
      }).join("");
      view.insertAdjacentHTML("beforeend", '<div class="card"><h2 style="margin:.1rem 0 .5rem;font-size:1.05rem">Focus Areas → Revisit These Labs</h2><ul class="weak-list">' + items + "</ul></div>");
    }

    renderProgressTools(p);
  }

  function renderProgressTools() {
    view.insertAdjacentHTML("beforeend",
      '<div class="card" style="margin-top:1rem"><h2 style="margin:.1rem 0 .5rem;font-size:1.05rem">Your Progress Data</h2>' +
      '<p class="muted" style="margin:.1rem 0 .7rem;font-size:.85rem">Stored only in this browser. Export to back it up or move it to another machine.</p>' +
      '<div class="row"><button class="btn" id="pg-export">⬇ Export</button>' +
      '<button class="btn" id="pg-import">⬆ Import</button>' +
      '<input type="file" id="pg-file" accept="application/json" hidden>' +
      '<span class="spacer"></span><button class="btn btn--ghost" id="pg-reset">Reset Progress</button></div></div>');

    document.getElementById("pg-export").addEventListener("click", function () {
      var exported = Object.assign({ exam: DATA.meta.slug }, loadProgress());
      var blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "study-" + DATA.meta.slug + "-progress.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    document.getElementById("pg-import").addEventListener("click", function () {
      document.getElementById("pg-file").click();
    });
    document.getElementById("pg-file").addEventListener("change", function (e) {
      var file = e.target.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var obj = JSON.parse(reader.result);
          if (!obj || (obj.version !== 1 && obj.version !== PROGRESS_VERSION) || !obj.questions || !obj.sessions) throw new Error("bad shape");
          // Exports from before multi-exam support carry no exam tag; they're CCAR-F.
          var from = obj.exam || LEGACY.exam;
          if (from !== DATA.meta.slug) {
            alert("That export is for a different exam (" + from + "). Switch to it in the header, then import.");
            return;
          }
          if (obj.version === PROGRESS_VERSION) {
            saveProgress({ version: PROGRESS_VERSION, questions: obj.questions, sessions: obj.sessions });
            router();
            return;
          }
          // v1 export (pre-pool IDs, possibly pre-multi-exam unprefixed ones).
          fetchPoolIds().then(function (mig) {
            saveProgress({ version: PROGRESS_VERSION, questions: rekeyRecords(prefixIds(obj.questions, from), mig.questions), sessions: obj.sessions });
            router();
          }).catch(function () { alert("Couldn't load the ID migration map to import that older export."); });
        } catch (err) { alert("That file doesn't look like a " + DATA.meta.code + " progress export."); }
      };
      reader.readAsText(file);
    });
    document.getElementById("pg-reset").addEventListener("click", function () {
      if (confirm("Erase all saved " + DATA.meta.code + " quiz progress in this browser? This cannot be undone.")) {
        localStorage.removeItem(PROGRESS_KEY); router();
      }
    });
  }

  /* ---- readiness sub-renderers ----------------------------------------- */
  function tile(num, label) {
    return '<div class="tile"><div class="tile__num">' + esc(num) + '</div><div class="tile__label">' + esc(label) + "</div></div>";
  }
  function barRow(labelHtml, valText, pct, color, subText) {
    return '<div class="bar-row"><div class="bar-row__label">' + labelHtml + "</div>" +
      '<div class="bar-row__val">' + esc(valText) + "</div>" +
      '<div class="bar-row__sub"><div class="track"><span style="width:' + pct + "%;background:" + color + '"></span></div>' +
      '<div class="muted" style="font-size:.76rem;margin-top:.2rem">' + esc(subText) + "</div></div></div>";
  }
  function sessionCount(p) { return p.sessions.length; }
  function bestStreak(p) {
    return p.sessions.reduce(function (m, s) {
      var pct = s.total ? Math.round((s.correct / s.total) * 100) : 0;
      return Math.max(m, pct);
    }, 0);
  }
  function lastStudied(p) {
    if (!p.sessions.length) return "—";
    var days = Math.floor((Date.now() - p.sessions[p.sessions.length - 1].ts) / 86400000);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : days + "d ago";
  }
  function sparkline(p) {
    var pts = p.sessions.map(function (s) { return s.readiness; });
    if (pts.length < 2) return '<p class="muted" style="font-size:.85rem">Complete a second quiz to see your trend.</p>';
    // Uniform-scaled viewBox (no preserveAspectRatio="none") so dots stay round
    // and strokes stay even. 0–100 y-scale keeps it honest vs the gauge; a dashed
    // line marks the ~72% pass threshold for context.
    var W = 600, H = 120, padX = 8, padTop = 12, padBot = 12;
    var plotH = H - padTop - padBot;
    var yFor = function (v) { return padTop + (1 - v / 100) * plotH; };
    var step = (W - padX * 2) / (pts.length - 1);
    var coords = pts.map(function (v, i) { return [padX + i * step, yFor(v)]; });
    var line = coords.map(function (c, i) { return (i ? "L" : "M") + c[0].toFixed(1) + " " + c[1].toFixed(1); }).join(" ");
    var area = "M" + coords[0][0].toFixed(1) + " " + (H - padBot) + " " +
      coords.map(function (c) { return "L" + c[0].toFixed(1) + " " + c[1].toFixed(1); }).join(" ") +
      " L" + coords[coords.length - 1][0].toFixed(1) + " " + (H - padBot) + " Z";
    var dots = coords.map(function (c) {
      return '<circle cx="' + c[0].toFixed(1) + '" cy="' + c[1].toFixed(1) + '" r="3" fill="var(--surface-1)" stroke="var(--accent)" stroke-width="2"></circle>';
    }).join("");
    var last = coords[coords.length - 1];
    var thr = yFor(72);
    var cur = pts[pts.length - 1];
    return '<svg class="sparkline" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Readiness across ' + pts.length + ' sessions, currently ' + cur + '%">' +
      '<defs><linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="var(--accent)" stop-opacity="0.28"></stop>' +
        '<stop offset="1" stop-color="var(--accent)" stop-opacity="0"></stop></linearGradient></defs>' +
      '<line x1="' + padX + '" y1="' + thr.toFixed(1) + '" x2="' + (W - padX) + '" y2="' + thr.toFixed(1) + '" stroke="var(--baseline)" stroke-width="1.5" stroke-dasharray="5 5"></line>' +
      '<path d="' + area + '" fill="url(#sparkfill)"></path>' +
      '<path d="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>' +
      dots +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="4.5" fill="var(--accent)"></circle></svg>' +
      '<div class="muted" style="display:flex;justify-content:space-between;font-size:.74rem;margin-top:.3rem">' +
        '<span>' + pts.length + ' sessions</span><span>dashed line = ~72% pass · now ' + cur + '%</span></div>';
  }

  // Minimal, dependency-free syntax highlighter (keeps the app offline). Tokenizes
  // strings, comments, numbers, CLI flags, keywords and literals; escapes everything
  // else. Returns safe HTML with <span class="tok-*"> wrappers.
  var KEYWORDS = {
    python: ["def", "return", "if", "elif", "else", "for", "while", "in", "is", "not", "and", "or",
      "import", "from", "as", "class", "with", "try", "except", "finally", "raise", "lambda", "pass",
      "break", "continue", "yield", "assert", "async", "await", "del", "global", "nonlocal"],
    bash: ["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac",
      "function", "export", "local", "return", "echo", "cd", "source"],
    json: [],
    yaml: [],
  };
  var _LIT = /^(true|false|null|None|True|False|nil|yes|no)$/;
  var _TOK = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(#[^\n]*)|(--?[A-Za-z][\w-]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;

  function highlightCode(code, lang) {
    if (!lang || lang === "text" || lang === "markdown") return esc(code);
    var kw = KEYWORDS[lang] || [];
    var allowHash = lang === "python" || lang === "yaml" || lang === "bash";
    var out = "", last = 0, m;
    _TOK.lastIndex = 0;
    while ((m = _TOK.exec(code)) !== null) {
      out += esc(code.slice(last, m.index));
      var t = m[0];
      if (m[1]) out += '<span class="tok-str">' + esc(t) + "</span>";
      else if (m[2]) out += allowHash ? '<span class="tok-com">' + esc(t) + "</span>" : esc(t);
      else if (m[3]) out += lang === "bash" ? '<span class="tok-attr">' + esc(t) + "</span>" : esc(t);
      else if (m[4]) out += '<span class="tok-num">' + esc(t) + "</span>";
      else if (m[5]) {
        if (_LIT.test(t)) out += '<span class="tok-lit">' + esc(t) + "</span>";
        else if (kw.indexOf(t) >= 0) out += '<span class="tok-kw">' + esc(t) + "</span>";
        else out += esc(t);
      }
      last = _TOK.lastIndex;
    }
    return out + esc(code.slice(last));
  }

  function codeSamplesHtml(samples) {
    return '<div class="code-samples">' + samples.map(function (s) {
      return (s.caption ? '<div class="code-cap">' + esc(s.caption) + "</div>" : "") +
        '<pre class="code-block"><span class="code-lang">' + esc(s.language) + '</span><code>' + highlightCode(s.code, s.language) + "</code></pre>";
    }).join("") + "</div>";
  }

  function emptyState(glyph, msg) {
    return '<div class="empty"><span class="empty__glyph">' + glyph + "</span>" + esc(msg) + "</div>";
  }

  /* ---- theme ------------------------------------------------------------ */
  function initTheme() {
    migrateLegacyTheme();
    var saved = localStorage.getItem(THEME_KEY);
    var theme = saved || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
    document.getElementById("theme-toggle").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(THEME_KEY, next);
    });
  }

  /* ---- set picker (Quiz question sets, Flashcards sets) ----------------- */
  // Every set the exam pins is eager-loaded at boot (small files, no
  // per-selection fetch/loading-state complexity); switching sets just swaps
  // which already-loaded array DATA.questions/DATA.flashcards points at.

  function pickInitialSetId(kind, key) {
    var entries = DATA.sets[kind];
    var saved = localStorage.getItem(key);
    if (saved && entries.some(function (e) { return e.id === saved; })) return saved;
    return entries[0].id;
  }
  function selectQuestionSet(id) {
    DATA.currentQuestionSet = id;
    DATA.questions = DATA.questionSets[id];
    localStorage.setItem(QUESTION_SET_KEY, id);
  }
  function selectFlashcardSet(id) {
    DATA.currentFlashcardSet = id;
    DATA.flashcards = DATA.flashcardSets[id];
    localStorage.setItem(FLASHCARD_SET_KEY, id);
  }
  function setOptions(kind, currentId) {
    return DATA.sets[kind].map(function (e) {
      return '<option value="' + esc(e.id) + '"' + (e.id === currentId ? " selected" : "") + ">" + esc(e.label) + "</option>";
    }).join("");
  }

  /* ---- boot ------------------------------------------------------------- */
  function fetchJSON(u) {
    return fetch(u).then(function (r) { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); });
  }
  // Content is resolved through manifests: exams/index.json lists exam slugs;
  // exams/<slug>/exam.json holds the exam's domains/tasks and the components
  // each section pins; exams/<slug>/map.json picks the pool items the exam
  // uses and their tasks; content/components.json maps component ids to files.
  // Pin versions are checked by the test suite, not at runtime.
  function resolvePins(pins, registry) {
    return pins.map(function (pin) {
      var comp = registry[pin.component];
      if (!comp) throw new Error("exam pins unknown component " + pin.component);
      return { id: comp.id, label: pin.label || comp.id, file: comp.file };
    });
  }
  function fetchAll(entries) {
    return Promise.all(entries.map(function (e) { return fetchJSON("../content/" + e.file); }));
  }
  function concatAll(lists) { return [].concat.apply([], lists); }
  // Pool items carry no exam tags: keep only the items the exam's map lists,
  // tagged with the map's task and that task's domain.
  function applyMap(items, mapping, taskDomain) {
    return items.filter(function (it) { return mapping[it.id]; }).map(function (it) {
      return Object.assign({}, it, { task_statement: mapping[it.id], domain: taskDomain[mapping[it.id]] });
    });
  }
  // Top stripe: segmented exam switcher (a dropdown once there are too many
  // exams to fit). Sub-nav stripe: the active exam's full name. The switcher's
  // links are re-pointed by router() so switching keeps the current view.
  var SWITCH_MAX_SEGMENTS = 5;
  function initExamChrome(exam, exams) {
    document.getElementById("exam-name").textContent = exam.name;
    document.title = exam.code + " · Claude Certification Study";
    var sw = document.getElementById("exam-switch");
    if (exams.length > SWITCH_MAX_SEGMENTS) {
      sw.innerHTML = '<select class="exam-switch__select" aria-label="Exam">' + exams.map(function (e) {
        return '<option value="' + esc(e.slug) + '"' + (e.slug === exam.slug ? " selected" : "") + ">" + esc(e.code) + "</option>";
      }).join("") + "</select>";
      sw.querySelector("select").addEventListener("change", function (ev) {
        location.hash = viewHref(currentRoute(), ev.target.value);
      });
      return;
    }
    sw.innerHTML = exams.map(function (e) {
      return '<a class="exam-switch__opt" data-exam="' + esc(e.slug) + '" href="' + viewHref("concepts", e.slug) + '" title="' + esc(e.name) + '"' +
        (e.slug === exam.slug ? ' aria-current="true"' : "") + ">" + esc(e.code) + "</a>";
    }).join("");
  }
  function boot() {
    initTheme();
    var registry = {}, appMeta;
    Promise.all(["../app.json", "../exams/index.json", "../content/components.json"].map(fetchJSON))
      .then(function (res) {
        appMeta = res[0];
        res[2].components.forEach(function (c) { registry[c.id] = c; });
        // Every exam manifest is small; load them all so the picker can label them.
        return Promise.all(res[1].exams.map(function (slug) { return fetchJSON("../exams/" + slug + "/exam.json"); }));
      })
      .then(function (exams) {
        // Exam precedence: the route (#/<exam>/…), then the last-used exam, then the first.
        EXAM_SLUGS = exams.map(function (e) { return e.slug; });
        var wanted = parseHash().exam || localStorage.getItem(EXAM_KEY);
        var exam = exams.filter(function (e) { return e.slug === wanted; })[0] || exams[0];
        EXAM = exam.slug;
        localStorage.setItem(EXAM_KEY, EXAM);
        DATA.meta = exam;
        useExamKeys(exam.slug);
        initExamChrome(exam, exams);
        if (exam.config && exam.config.pass_threshold) PASS_THRESHOLD = exam.config.pass_threshold;
        DATA.sets = {
          questions: resolvePins(exam.sections.questions, registry),
          flashcards: resolvePins(exam.sections.flashcards, registry),
        };
        return Promise.all([
          fetchAll(DATA.sets.questions),
          fetchAll(DATA.sets.flashcards),
          fetchAll(resolvePins(exam.sections.concepts, registry)),
          fetchAll(resolvePins(exam.sections.labs, registry)),
          fetchJSON("../exams/" + exam.slug + "/map.json"),
          migrateStorage(exam.slug, registry),
        ]);
      })
      .then(function (loaded) {
        var map = loaded[4], taskDomain = {};
        DATA.meta.task_statements.forEach(function (t) { taskDomain[t.id] = t.domain; });
        DATA.concepts = applyMap(concatAll(loaded[2]), map.concepts, taskDomain);
        DATA.labs = concatAll(loaded[3]);
        DATA.questionSets = {}; DATA.flashcardSets = {};
        DATA.sets.questions.forEach(function (e, i) { DATA.questionSets[e.id] = applyMap(loaded[0][i], map.questions, taskDomain); });
        DATA.sets.flashcards.forEach(function (e, i) { DATA.flashcardSets[e.id] = applyMap(loaded[1][i], map.flashcards, taskDomain); });
        selectQuestionSet(pickInitialSetId("questions", QUESTION_SET_KEY));
        selectFlashcardSet(pickInitialSetId("flashcards", FLASHCARD_SET_KEY));

        var appVersion = appMeta && appMeta.app_version;
        if (appVersion) {
          document.getElementById("app-version").textContent = "v" + appVersion;
          document.getElementById("app-version").hidden = false;
          document.getElementById("app-version-sep").hidden = false;
        }
        window.addEventListener("hashchange", router);
        router();
      })
      .catch(function (err) {
        view.innerHTML = '<div class="empty"><span class="empty__glyph">⚠️</span>Could not load study data.<br><span class="muted">' + esc(err.message) +
          '</span><br><br>Run <code>uv run study/serve.py</code> from the repo root and open the printed URL (don’t open index.html directly).</div>';
      });
  }
  boot();
})();
