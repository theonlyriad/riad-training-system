
const DB_KEY = "riad_users_v2";
const SESSION_KEY = "riad_session_v2";
const API_URL = "/api";
// --------------------------- STORAGE HELPERS ---------------------------

function loadUsers() {
    try {
        return JSON.parse(localStorage.getItem(DB_KEY) || "{}");
    } catch {
        return {};
    }
}

function saveUsers(users) {
    localStorage.setItem(DB_KEY, JSON.stringify(users));
}

function getSession() {
    return sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
}

function setSession(username, remember) {

    sessionStorage.setItem(SESSION_KEY, username);
    if (remember !== false) localStorage.setItem(SESSION_KEY, username);
}

function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
}

async function hashPassword(password, salt) {
    const enc = new TextEncoder();
    const data = enc.encode(salt + ":" + password);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomSalt() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

// --------------------------- CURRENT USER STATE ---------------------------

let currentUsername = null;

function getCurrentUser() {
    const users = loadUsers();
    return currentUsername ? users[currentUsername] : null;
}

function updateCurrentUser(mutatorFn) {
    const users = loadUsers();
    const user = users[currentUsername];
    if (!user) return;
    mutatorFn(user);
    saveUsers(users);
}

// =====================================================================
// PERSONALIZATION ENGINE
// All numbers below are derived from the person's own inputs.
// =====================================================================

function calcBMI(weightKg, heightCm) {
    const h = heightCm / 100;
    return weightKg / (h * h);
}

function bmiTag(bmi) {
    if (bmi < 18.5) return "Underweight";
    if (bmi < 25) return "Healthy range";
    if (bmi < 30) return "Above range";
    return "Well above range";
}

// Mifflin-St Jeor equation — the standard, evidence-based BMR formula.
function calcBMR({ gender, currentWeight, heightCm, age }) {
    const base = 10 * currentWeight + 6.25 * heightCm - 5 * age;
    return gender === "Male" ? base + 5 : base - 161;
}

function calcTDEE(bmr, activityFactor) {
    return bmr * activityFactor;
}

function calcTargetCalories(tdee, goal) {
    switch (goal) {
        case "Fat Loss": return tdee - 500;
        case "Lean Muscle Gain": return tdee + 250;
        case "Bulking": return tdee + 500;
        case "Recomposition": return tdee - 150;
        default: return tdee;
    }
}

function calcProteinTarget(weightKg, goal) {
    // g/kg bodyweight, scaled by goal — higher in a deficit to protect muscle.
    const factor = (goal === "Fat Loss" || goal === "Recomposition") ? 2.2 : 1.9;
    return Math.round(weightKg * factor);
}

function calcWeeksToTarget(currentWeight, targetWeight, goal) {
    const diff = Math.abs(targetWeight - currentWeight);
    if (diff < 0.5) return 0;
    // Sustainable weekly change estimate depending on direction.
    const losing = targetWeight < currentWeight;
    const weeklyRate = losing ? 0.6 : 0.3; // kg/week, conservative & sustainable
    return Math.max(1, Math.round(diff / weeklyRate));
}

function computeMetrics(inputs) {
    const bmi = calcBMI(inputs.currentWeight, inputs.heightCm);
    const bmr = calcBMR(inputs);
    const tdee = calcTDEE(bmr, inputs.activity);
    const targetCalories = calcTargetCalories(tdee, inputs.goal);
    const protein = calcProteinTarget(inputs.currentWeight, inputs.goal);
    const weeks = calcWeeksToTarget(inputs.currentWeight, inputs.targetWeight, inputs.goal);
    return {
        bmi: Math.round(bmi * 10) / 10,
        bmiTag: bmiTag(bmi),
        bmr: Math.round(bmr),
        tdee: Math.round(tdee),
        targetCalories: Math.round(targetCalories),
        protein,
        weeks
    };
}

// --------------------------- EXERCISE LIBRARY ---------------------------
// Each exercise tagged by movement pattern + which constraint keywords
// would exclude it. The PROGRAM BUILDER below selects + sequences these
// based on level, days, goal, and constraints — not a fixed lookup.

const EXERCISES = {
    squat: [
        { name: "Back Squat", cue: "Brace, full depth", tags: ["knee"] },
        { name: "Front Squat", cue: "Elbows up, controlled", tags: ["knee"] },
        { name: "Goblet Squat", cue: "Light, mobility-friendly", tags: [] },
    ],
    hinge: [
        { name: "Conventional Deadlift", cue: "Neutral spine, drive floor", tags: ["lowerback"] },
        { name: "Romanian Deadlift", cue: "Hamstring stretch, hips back", tags: [] },
        { name: "Trap Bar Deadlift", cue: "Easier on the back", tags: [] },
    ],
    lunge: [
        { name: "Walking Lunge", cue: "Knee tracks over foot", tags: ["knee"] },
        { name: "Bulgarian Split Squat", cue: "Torso slightly forward", tags: ["knee"] },
        { name: "Step-Up", cue: "Drive through heel", tags: [] },
    ],
    horizontalPush: [
        { name: "Barbell Bench Press", cue: "Shoulder blades pinned", tags: [] },
        { name: "Dumbbell Bench Press", cue: "Full range, controlled", tags: [] },
        { name: "Push-Up", cue: "Bodyweight, rigid core", tags: [] },
    ],
    verticalPush: [
        { name: "Overhead Press", cue: "Ribs down, press up & back", tags: ["overhead", "shoulder"] },
        { name: "Landmine Press", cue: "Shoulder-friendly angle", tags: ["overhead"] },
        { name: "Seated Dumbbell Press", cue: "Controlled tempo", tags: ["overhead", "shoulder"] },
    ],
    horizontalPull: [
        { name: "Barbell Row", cue: "Flat back, pull to ribs", tags: ["lowerback"] },
        { name: "Chest-Supported Row", cue: "No lower back load", tags: [] },
        { name: "Seated Cable Row", cue: "Squeeze shoulder blades", tags: [] },
    ],
    verticalPull: [
        { name: "Pull-Up", cue: "Full hang to chin over bar", tags: ["shoulder"] },
        { name: "Lat Pulldown", cue: "Lead with elbows", tags: [] },
        { name: "Assisted Pull-Up", cue: "Build toward full reps", tags: [] },
    ],
    accessory: [
        { name: "Lateral Raise", cue: "Light, controlled", tags: ["shoulder"] },
        { name: "Biceps Curl", cue: "No swinging", tags: [] },
        { name: "Triceps Pushdown", cue: "Elbows pinned", tags: [] },
        { name: "Face Pull", cue: "Rear delts + rotator cuff", tags: [] },
        { name: "Leg Curl", cue: "Controlled tempo", tags: ["knee"] },
        { name: "Calf Raise", cue: "Full stretch, full contraction", tags: [] },
        { name: "Plank / Core Carry", cue: "Brace, breathe normally", tags: [] },
    ],
};

function pickExercise(pattern, excludedTags) {
    const list = EXERCISES[pattern].filter(ex => !ex.tags.some(t => excludedTags.includes(t)));
    // Deterministic-ish variety: prefer first non-excluded option.
    return list[0] || EXERCISES[pattern][0];
}

function parseConstraints(text) {
    const t = (text || "").toLowerCase();
    const excluded = [];
    if (t.includes("knee")) excluded.push("knee");
    if (t.includes("shoulder")) excluded.push("shoulder");
    if (t.includes("overhead")) excluded.push("overhead");
    if (t.includes("back") || t.includes("spine")) excluded.push("lowerback");
    return excluded;
}

// Sets/reps prescription scaled by level AND goal — this is the part
// that makes two people with the same level get different prescriptions.
function prescriptionFor(level, goal, slot) {
    // slot: "primary" (compound) or "accessory"
    const table = {
        Beginner: {
            primary: { "Fat Loss": "3×12", "Lean Muscle Gain": "3×10", "Bulking": "2×8-10", "Recomposition": "3×10-12" },
            accessory: { "Fat Loss": "3×15", "Lean Muscle Gain": "3×12", "Bulking": "2×10-12", "Recomposition": "3×12-15" },
        },
        Intermediate: {
            primary: { "Fat Loss": "3×10-12", "Lean Muscle Gain": "3×8", "Bulking": "2×6-8", "Recomposition": "3×8-10" },
            accessory: { "Fat Loss": "3×15", "Lean Muscle Gain": "3×10-12", "Bulking": "2×10", "Recomposition": "3×12" },
        },
        Advanced: {
            primary: { "Fat Loss": "2×failure", "Lean Muscle Gain": "2×failure", "Bulking": "2×failure", "Recomposition": "2×failure" },
            accessory: { "Fat Loss": "2×failure", "Lean Muscle Gain": "2×failure", "Bulking": "2×failure", "Recomposition": "2×failure" },
        },
    };
    return table[level][slot][goal];
}

function restFor(level, slot) {
    if (slot === "accessory") return "45-60s";
    return { Beginner: "90s", Intermediate: "105s", Advanced: "120-150s" }[level];
}

// Builds the actual day-by-day plan. days/level/goal/constraints all
// change the output — this replaces the old fixed `workouts` object.
function buildSplit(days, level) {
    if (days === 3) return ["Full Body A", "Full Body B", "Full Body C"];
    if (days === 4) return ["Upper Body", "Lower Body", "Upper Body", "Lower Body"];
    if (days === 5) return ["Push", "Pull", "Legs", "Upper Body", "Lower Body"];
    return ["Push", "Pull", "Legs", "Push", "Pull", "Legs"]; // 6 days
}

function dayBlueprint(dayName) {
    // Returns ordered list of [pattern, slot]
    switch (dayName) {
        case "Full Body A": return [["squat", "primary"], ["horizontalPush", "primary"], ["horizontalPull", "primary"], ["accessory", "accessory"], ["accessory", "accessory"]];
        case "Full Body B": return [["hinge", "primary"], ["verticalPull", "primary"], ["verticalPush", "primary"], ["accessory", "accessory"], ["accessory", "accessory"]];
        case "Full Body C": return [["lunge", "primary"], ["horizontalPull", "primary"], ["horizontalPush", "primary"], ["accessory", "accessory"], ["accessory", "accessory"]];
        case "Upper Body": return [["horizontalPush", "primary"], ["verticalPull", "primary"], ["verticalPush", "primary"], ["horizontalPull", "primary"], ["accessory", "accessory"], ["accessory", "accessory"]];
        case "Lower Body": return [["squat", "primary"], ["hinge", "primary"], ["lunge", "primary"], ["accessory", "accessory"], ["accessory", "accessory"]];
        case "Push": return [["horizontalPush", "primary"], ["verticalPush", "primary"], ["accessory", "accessory"], ["accessory", "accessory"]];
        case "Pull": return [["hinge", "primary"], ["verticalPull", "primary"], ["horizontalPull", "primary"], ["accessory", "accessory"]];
        case "Legs": return [["squat", "primary"], ["lunge", "primary"], ["hinge", "primary"], ["accessory", "accessory"], ["accessory", "accessory"]];
        default: return [];
    }
}

function buildProgram(inputs, metrics) {
    const excluded = parseConstraints(inputs.constraints);
    const split = buildSplit(inputs.days, inputs.level);

    const usedAccessories = new Set(); // rotate accessories so days don't repeat identically
    const accessoryPool = EXERCISES.accessory.filter(a => !a.tags.some(t => excluded.includes(t)));

    const days = split.map((dayName, idx) => {
        const blueprint = dayBlueprint(dayName);
        const exercises = blueprint.map(([pattern, slot]) => {
            let ex;
            if (pattern === "accessory") {
                // pick next unused accessory, cycling
                ex = accessoryPool[usedAccessories.size % accessoryPool.length];
                usedAccessories.add(ex.name + idx); // allow reuse across days, vary within day
            } else {
                ex = pickExercise(pattern, excluded);
            }
            return {
                name: ex.name,
                cue: ex.cue,
                sets: prescriptionFor(inputs.level, inputs.goal, slot),
                rest: restFor(inputs.level, slot),
            };
        });
        return { day: idx + 1, name: dayName, exercises };
    });

    return {
        generatedAt: new Date().toISOString(),
        inputs,
        metrics,
        targetCalories: metrics.targetCalories || metrics.target || metrics.targetKcal,
        protein: metrics.protein,
        days,
    };
}

// =====================================================================
// RENDERING
// =====================================================================

function renderProgramHTML(program) {
    const { inputs, metrics, days, generatedAt } = program;
    const dateStr = new Date(generatedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

    const summary = `
    <div class="program-summary">
      <div class="summary-chip"><span>TARGET CALORIES</span><strong>${metrics.targetCalories} kcal</strong></div>
      <div class="summary-chip"><span>PROTEIN TARGET</span><strong>${metrics.protein} g</strong></div>
      <div class="summary-chip"><span>BMI</span><strong>${metrics.bmi} · ${metrics.bmiTag}</strong></div>
      <div class="summary-chip"><span>EST. TIMELINE</span><strong>${metrics.weeks > 0 ? metrics.weeks + " wks" : "At target"}</strong></div>
    </div>
  `;

    const dayBlocks = days.map(d => `
    <div class="day-block">
      <div class="day-head"><span>Day ${d.day}</span>${d.name}<span>${d.exercises.length} exercises</span></div>
      <div class="exercise-row head-row">
        <span>Exercise</span><span>Sets × Reps</span><span>Rest</span><span>Cue</span>
      </div>
      ${d.exercises.map(ex => `
        <div class="exercise-row">
          <span class="exercise-name">${ex.name}</span>
          <span>${ex.sets}</span>
          <span>${ex.rest}</span>
          <span class="exercise-cue">${ex.cue}</span>
        </div>
      `).join("")}
    </div>
  `).join("");

    return `
    <div class="program-doc" data-program-doc>
      <div class="program-doc-header">
        <div>
          <h3>${inputs.name || "Training"} — ${inputs.goal}</h3>
        </div>
        <div class="program-meta">
          <span>LEVEL <strong>${inputs.level}</strong></span>
          <span>DAYS/WK <strong>${inputs.days}</strong></span>
          <span>GENERATED <strong>${dateStr}</strong></span>
        </div>
      </div>
      ${summary}
      ${dayBlocks}
      <div class="program-notes">
        <h4>Coaching notes</h4>
        <ul>
          <li>Progressive overload: add weight or reps weekly once all sets hit the top of the rep range.</li>
          <li>Leave 1–2 reps in reserve (RIR) on most working sets.</li>
          <li>Sleep 7–9 hours — recovery is where the adaptation actually happens.</li>
          <li>Hit ~${metrics.protein}g protein/day to support this goal.</li>
          ${inputs.constraints ? `<li>Adjusted for: ${inputs.constraints}.</li>` : ""}
        </ul>
      </div>
      <div class="program-actions">
        <button class="btn-secondary" data-download-btn><i class="fa-solid fa-download"></i>&nbsp; Download as image</button>
      </div>
    </div>
  `;
}

// =====================================================================
// LIVE READOUT (auth-time + generate-time calculation feedback)
// =====================================================================

function readGenerateInputs() {
    return {
        name: getCurrentUser()?.displayName || "",
        gender: document.getElementById("gender").value,
        age: parseFloat(document.getElementById("age").value) || 0,
        heightCm: parseFloat(document.getElementById("height").value) || 0,
        currentWeight: parseFloat(document.getElementById("currentWeight").value) || 0,
        targetWeight: parseFloat(document.getElementById("targetWeight").value) || 0,
        activity: parseFloat(document.getElementById("activity").value),
        level: document.getElementById("level").value,
        days: parseInt(document.getElementById("days").value, 10),
        goal: document.getElementById("goal").value,
        constraints: document.getElementById("constraints").value.trim(),
    };
}

function updateLiveReadout() {
    const inputs = readGenerateInputs();
    if (!inputs.heightCm || !inputs.currentWeight || !inputs.age) return;

    const metrics = computeMetrics(inputs);

    document.getElementById("rcBmi").textContent = metrics.bmi;
    document.getElementById("rcBmiTag").textContent = metrics.bmiTag;
    document.getElementById("rcBmr").textContent = metrics.bmr;
    document.getElementById("rcTdee").textContent = metrics.tdee;
    document.getElementById("rcTarget").textContent = metrics.targetCalories;
    document.getElementById("rcTargetTag").textContent = `kcal / day · ${inputs.goal}`;
    document.getElementById("rcProtein").textContent = metrics.protein + "g";

    const weeksEl = document.getElementById("rcWeeks");
    const weeksTag = document.getElementById("rcWeeksTag");
    if (metrics.weeks === 0) {
        weeksEl.textContent = "—";
        weeksTag.textContent = "already at target weight";
    } else {
        weeksEl.textContent = `~${metrics.weeks}w`;
        weeksTag.textContent = inputs.targetWeight < inputs.currentWeight ? "to reach target weight" : "to reach target weight";
    }
}

// =====================================================================
// VIEW NAVIGATION
// =====================================================================

function setView(viewName) {
    document.querySelectorAll(".view").forEach(v => v.style.display = "none");
    document.getElementById("view-" + viewName).style.display = "block";
    document.querySelectorAll(".side-nav-item").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.view === viewName);
    });
    if (viewName === "history") renderHistory();
    if (viewName === "profile") renderProfile();
    if (viewName === "current") renderCurrent();
}

// =====================================================================
// RENDER: CURRENT / HISTORY / PROFILE
// =====================================================================

function renderCurrent() {
    const user = getCurrentUser();
    const host = document.getElementById("currentProgramHost");
    const sub = document.getElementById("currentSub");
    if (!user || !user.currentProgram) {
        host.innerHTML = `<p class="empty-note">No program yet — head to <strong>Generate</strong> to build your first one.</p>`;
        sub.textContent = "Generate a program to see it here.";
        return;
    }
    sub.textContent = `Last generated ${new Date(user.currentProgram.generatedAt).toLocaleString()}`;
    host.innerHTML = renderProgramHTML(user.currentProgram);
    attachDownloadHandler(host);
}

async function loadProgramsFromDatabase() {
    try {
        const response = await fetch(
            `${API_URL}/programs/${currentUsername}`
        );

        if (!response.ok) return [];

        const programs = await response.json();

        return programs.map(p => ({
            dbId: p.id,
            ...p.program_data
        }));
    } catch (err) {
        console.error(err);
        return [];
    }
}

async function loadUserFromDatabase(username) {
    try {
        const response = await fetch(
            `${API_URL}/user/${username}`
        );

        if (!response.ok) return null;

        return await response.json();
    } catch (err) {
        console.error(err);
        return null;
    }
}

async function renderHistory() {
    const user = getCurrentUser();
    const list = document.getElementById("historyList");
    const history = (await loadProgramsFromDatabase()).slice().reverse();
    if (history.length === 0) {
        list.innerHTML = `<p class="empty-note">Nothing here yet. Programs you generate will be logged automatically.</p>`;
        return;
    }

    list.innerHTML = history.map((p, revIdx) => {
        const idx = revIdx;
        const date = new Date(p.generatedAt).toLocaleString();
        return `
      <div class="history-card">
        <div class="history-info">
          <strong>${p.inputs.goal} · ${p.inputs.days}d/wk · ${p.inputs.level}</strong>
          <p>${date} — Target ${p.metrics.targetCalories} kcal · ${p.metrics.protein}g protein</p>
        </div>
        <div class="history-actions">
          <button class="btn-ghost" data-view-history="${idx}">View</button>
          <button class="btn-ghost danger" data-delete-history="${idx}">Delete</button>
        </div>
      </div>
    `;
    }).join("");

    list.querySelectorAll("[data-view-history]").forEach(btn => {
        btn.addEventListener("click", () => {
            const idx = parseInt(btn.dataset.viewHistory, 10);
            const program = history[idx];
            const host = document.getElementById("currentProgramHost");
            host.innerHTML = renderProgramHTML(program);
            attachDownloadHandler(host);
            document.getElementById("currentSub").textContent = `Viewing from ${new Date(program.generatedAt).toLocaleString()}`;
            document.querySelectorAll(".view").forEach(v => v.style.display = "none");
            document.getElementById("view-current").style.display = "block";

            document.querySelectorAll(".side-nav-item").forEach(btn => {
                btn.classList.toggle("active", btn.dataset.view === "current");
            });
        });
    });

    list.querySelectorAll("[data-delete-history]").forEach(btn => {
        btn.addEventListener("click", async () => {
            const idx = parseInt(btn.dataset.deleteHistory, 10);
            const program = history[idx];

            if (!confirm("Delete this program?")) return;

            await fetch(`${API_URL}/programs/${program.dbId}`, {
                method: "DELETE"
            });

            renderHistory();
        });
    });
}

function renderProfile() {
    const user = getCurrentUser();
    if (!user) return;
    document.getElementById("profileNameInput").value = user.displayName || "";
    document.getElementById("profileUsernameStatic").value = "@" + currentUsername;
    document.getElementById("profileEmailInput").value = user.email || "";

    const statsHost = document.getElementById("profileStatsHost");
    const p = user.currentProgram;
    if (!p) {
        statsHost.innerHTML = `<p class="empty-note">No intake submitted yet.</p>`;
        return;
    }
    const i = p.inputs, m = p.metrics;
    statsHost.innerHTML = `
    <div class="stat-line"><span>Sex</span><strong>${i.gender}</strong></div>
    <div class="stat-line"><span>Age</span><strong>${i.age}</strong></div>
    <div class="stat-line"><span>Height</span><strong>${i.heightCm} cm</strong></div>
    <div class="stat-line"><span>Current weight</span><strong>${i.currentWeight} kg</strong></div>
    <div class="stat-line"><span>Target weight</span><strong>${i.targetWeight} kg</strong></div>
    <div class="stat-line"><span>BMI</span><strong>${m.bmi} (${m.bmiTag})</strong></div>
    <div class="stat-line"><span>BMR / TDEE</span><strong>${m.bmr} / ${m.tdee} kcal</strong></div>
    <div class="stat-line"><span>Training level</span><strong>${i.level}</strong></div>
    <div class="stat-line"><span>Goal</span><strong>${i.goal}</strong></div>
  `;
}

function attachDownloadHandler(host) {
    const btn = host.querySelector("[data-download-btn]");
    if (!btn) return;
    btn.addEventListener("click", () => {
        const doc = host.querySelector("[data-program-doc]");
        html2canvas(doc, { backgroundColor: "#F5F2EA", scale: 2 }).then(canvas => {
            const link = document.createElement("a");
            link.download = "my_program.png";
            link.href = canvas.toDataURL();
            link.click();
        });
    });
}

// =====================================================================
// AVATAR HANDLING
// =====================================================================

function applyAvatar(user) {
    const initial = (user.displayName || currentUsername || "?").charAt(0).toUpperCase();
    [
        { img: "avatarImg", span: "avatarInitial" },
        { img: "avatarImgLarge", span: "avatarInitialLarge" },
    ].forEach(({ img, span }) => {
        const imgEl = document.getElementById(img);
        const spanEl = document.getElementById(span);
        if (user.avatar) {
            imgEl.src = user.avatar;
            imgEl.style.display = "block";
            spanEl.style.display = "none";
        } else {
            imgEl.style.display = "none";
            spanEl.style.display = "block";
            spanEl.textContent = initial;
        }
    });
}

function setupAvatarUpload(triggerId, inputId) {
    document.getElementById(triggerId).addEventListener("click", () => {
        document.getElementById(inputId).click();
    });
}

document.getElementById("avatarInput").addEventListener("change", handleAvatarFile);

function handleAvatarFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        updateCurrentUser(user => { user.avatar = reader.result; });
        applyAvatar(getCurrentUser());

        fetch(`${API_URL}/avatar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: currentUsername,
                avatar: reader.result
            })
        }).catch(err => console.error("Avatar save failed:", err));
    };
    reader.readAsDataURL(file);
    e.target.value = "";
}

// =====================================================================
// AUTH FLOWS
// =====================================================================

document.getElementById("goToSignup").addEventListener("click", () => {
    document.getElementById("loginPage").style.display = "none";
    document.getElementById("signupPage").style.display = "block";
});
document.getElementById("goToLogin").addEventListener("click", () => {
    document.getElementById("signupPage").style.display = "none";
    document.getElementById("loginPage").style.display = "block";
});

document.getElementById("goToForgot").addEventListener("click", () => {
    document.getElementById("loginPage").style.display = "none";
    document.getElementById("signupPage").style.display = "none";
    document.getElementById("forgotPage").style.display = "block";
});

document.getElementById("backToLoginFromForgot").addEventListener("click", () => {
    document.getElementById("forgotPage").style.display = "none";
    document.getElementById("loginPage").style.display = "block";
});

document.getElementById("forgotBtn").addEventListener("click", async () => {
    const email = document.getElementById("forgotEmail").value.trim();
    const errEl = document.getElementById("forgotError");
    const confirmEl = document.getElementById("forgotConfirm");

    errEl.textContent = "";
    confirmEl.textContent = "";

    if (!email) {
        errEl.textContent = "Please enter your email.";
        return;
    }

    const response = await fetch(`${API_URL}/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
    });

    const data = await response.json();
    confirmEl.textContent = data.message;
});

document.getElementById("signupBtn").addEventListener("click", async () => {
    const name = document.getElementById("signupName").value.trim();
    const username = document.getElementById("signupUsername").value.trim().toLowerCase();
    const password = document.getElementById("signupPassword").value;
    const email = document.getElementById("signupEmail").value.trim();
    const errEl = document.getElementById("signupError");
    errEl.textContent = "";

    if (!name || !username || !password || !email) { errEl.textContent = "Please fill in every field."; return; }
    if (password.length < 6) { errEl.textContent = "Password needs at least 6 characters."; return; }

    const response = await fetch(`${API_URL}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name, username, email, password })
    });

    const data = await response.json();

    if (!response.ok) {
        errEl.textContent = data.message;
        return;
    }

    const users = loadUsers();
    users[username] = {
        displayName: name,
        avatar: null,
        currentProgram: null,
        history: [],
        createdAt: new Date().toISOString(),
    };
    saveUsers(users);

    const dbUser = await loadUserFromDatabase(username);

    if (dbUser) {
        const users = loadUsers();

        users[username] = users[username] || {};

        users[username].displayName = dbUser.display_name;
        users[username].avatar = dbUser.avatar;
        users[username].email = dbUser.email;

        saveUsers(users);
    }

    alert("Account created. Please verify your email before logging in.");

    document.getElementById("signupPage").style.display = "none";
    document.getElementById("loginPage").style.display = "block";

    document.getElementById("signupName").value = "";
    document.getElementById("signupEmail").value = "";
    document.getElementById("signupUsername").value = "";
    document.getElementById("signupPassword").value = "";
});

document.getElementById("loginBtn").addEventListener("click", async () => {
    const username = document.getElementById("loginUsername").value.trim().toLowerCase();
    const password = document.getElementById("loginPassword").value;
    const errEl = document.getElementById("loginError");
    errEl.textContent = "";

    const response = await fetch(`${API_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (!response.ok) {
        errEl.textContent = data.message;
        return;
    }

    const users = loadUsers();
    users[username] = users[username] || {
        displayName: data.user.display_name,
        avatar: null,
        currentProgram: null,
        history: [],
        createdAt: new Date().toISOString(),
    };
    saveUsers(users);

    localStorage.setItem("riad_token", data.token);

    currentUsername = username;
    setSession(username);
    enterApp();
});

document.getElementById("logoutBtn").addEventListener("click", () => {
    localStorage.removeItem("riad_token");
    clearSession();
    currentUsername = null;
    document.getElementById("appShell").style.display = "none";
    document.getElementById("authScreen").style.display = "flex";
    document.getElementById("loginUsername").value = "";
    document.getElementById("loginPassword").value = "";
});

// --------------------------- ENTER APP ---------------------------

async function enterApp() {
    const user = getCurrentUser();
    document.getElementById("authScreen").style.display = "none";
    document.getElementById("appShell").style.display = "grid";

    document.getElementById("sidebarName").textContent = user.displayName;
    document.getElementById("sidebarUsername").textContent = "@" + currentUsername;
    applyAvatar(user);

    const programs = await loadProgramsFromDatabase();

    if (programs.length > 0) {
        updateCurrentUser(user => {
            user.history = programs;
            user.currentProgram = programs[0];
        });
    }

    setView("generate");
    updateLiveReadout();
}

// =====================================================================
// PROGRAM GENERATION SUBMIT
// =====================================================================

document.getElementById("programForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const inputs = readGenerateInputs();
    const metrics = computeMetrics(inputs);
    const program = buildProgram(inputs, metrics);

    updateCurrentUser(user => {
        user.currentProgram = program;
        user.history = user.history || [];
        user.history.push(program);
    });

    try {
        const token = localStorage.getItem("riad_token");

        await fetch(`${API_URL}/programs`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                program
            })
        });
    } catch (err) {
        console.error("Program save failed:", err);
    }

    setView("current");
});

["gender", "age", "height", "currentWeight", "targetWeight", "activity", "level", "days", "goal", "constraints"]
    .forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener("input", updateLiveReadout);
        el.addEventListener("change", updateLiveReadout);
    });

// =====================================================================
// PROFILE EDITING
// =====================================================================

setupAvatarUpload("avatarBtn", "avatarInput");
setupAvatarUpload("avatarBtnLarge", "avatarInput");

document.getElementById("saveProfileBtn").addEventListener("click", async () => {
    const newName = document.getElementById("profileNameInput").value.trim();
    const newEmail = document.getElementById("profileEmailInput").value.trim();
    const currentPassword = document.getElementById("currentPasswordInput").value;
    const newPassword = document.getElementById("newPasswordInput").value;
    const errEl = document.getElementById("profilePasswordError");
    const confirm = document.getElementById("profileSaveConfirm");

    errEl.textContent = "";
    confirm.textContent = "";

    if (!newName || !newEmail) {
        errEl.textContent = "Display name and email are required.";
        return;
    }

    const token = localStorage.getItem("riad_token");

    const response = await fetch(`${API_URL}/profile`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
            displayName: newName,
            email: newEmail,
            currentPassword,
            newPassword
        })
    });

    const data = await response.json();

    if (!response.ok) {
        errEl.textContent = data.message;
        return;
    }

    updateCurrentUser(user => {
        user.displayName = newName;
        user.email = newEmail;
    });

    document.getElementById("sidebarName").textContent = newName;
    document.getElementById("currentPasswordInput").value = "";
    document.getElementById("newPasswordInput").value = "";

    applyAvatar(getCurrentUser());

    confirm.textContent = "Profile updated successfully.";
    setTimeout(() => confirm.textContent = "", 2000);
});

// =====================================================================
// SIDE NAV
// =====================================================================

document.querySelectorAll(".side-nav-item").forEach(btn => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
});

// =====================================================================
// BOOT / AUTO-LOGIN
// =====================================================================

const resetToken = new URLSearchParams(window.location.search).get("resetToken");
const verifyToken = new URLSearchParams(window.location.search).get("verifyToken");

if (resetToken) {
    document.getElementById("loginPage").style.display = "none";
    document.getElementById("signupPage").style.display = "none";
    document.getElementById("forgotPage").style.display = "none";
    document.getElementById("resetPage").style.display = "block";
}

document.getElementById("resetBtn").addEventListener("click", async () => {
    const password = document.getElementById("resetPassword").value;
    const errEl = document.getElementById("resetError");
    const confirmEl = document.getElementById("resetConfirm");

    errEl.textContent = "";
    confirmEl.textContent = "";

    if (password.length < 6) {
        errEl.textContent = "Password needs at least 6 characters.";
        return;
    }

    const response = await fetch(`${API_URL}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            token: resetToken,
            password
        })
    });

    const data = await response.json();

    if (!response.ok) {
        errEl.textContent = data.message;
        return;
    }

    confirmEl.textContent = "Password updated. You can now log in.";
});

if (verifyToken) {
    fetch(`${API_URL}/verify-email/${verifyToken}`)
        .then(res => res.json())
        .then(data => {
            alert(data.message);
            window.location.href = "index.html";
        })
        .catch(() => {
            alert("Email verification failed.");
        });
}
(async function boot() {
    const profileCountEl = document.getElementById("profileCount");

    //profile counting
    //profileCountEl.textContent = Object.keys(loadUsers()).length;

    const token = localStorage.getItem("riad_token");

    if (!token) return;

    try {
        const response = await fetch(`${API_URL}/me`, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        if (!response.ok) {
            localStorage.removeItem("riad_token");
            clearSession();
            return;
        }

        const dbUser = await response.json();
        const username = dbUser.username;

        const users = loadUsers();
        users[username] = users[username] || {};
        users[username].displayName = dbUser.display_name;
        users[username].avatar = dbUser.avatar;
        users[username].email = dbUser.email;
        users[username].history = users[username].history || [];
        users[username].currentProgram = users[username].currentProgram || null;
        saveUsers(users);

        currentUsername = username;
        setSession(username);
        await enterApp();

    } catch (error) {
        console.error(error);
        localStorage.removeItem("riad_token");
        clearSession();
    }
})();