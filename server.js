const crypto = require("crypto");
const nodemailer = require("nodemailer");
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const cors = require("cors");
require("dotenv").config();
const jwt = require("jsonwebtoken");
function authenticateToken(req, res, next) {
    const authHeader = req.headers["authorization"];

    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({
            message: "Access denied"
        });
    }

    jwt.verify(
        token,
        process.env.JWT_SECRET,
        (err, user) => {

            if (err) {
                return res.status(403).json({
                    message: "Invalid token"
                });
            }

            req.user = user;
            next();
        }
    );
}
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
    if (req.url.startsWith("/api/")) {
        req.url = req.url.replace("/api", "");
    }
    next();
});
app.use(express.urlencoded({ limit: "10mb", extended: true }));


const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: {
        rejectUnauthorized: false
    }
});

app.post("/signup", async (req, res) => {
    try {
        const { displayName, username, email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationToken = crypto.randomBytes(32).toString("hex");
        const verificationExpires = new Date(Date.now() + 1000 * 60 * 60 * 24);

        const result = await pool.query(
            `INSERT INTO users (
      display_name,
      username,
      email,
      password,
      email_verification_token,
      email_verification_expires
   )
   VALUES ($1, $2, $3, $4, $5, $6)
   RETURNING id, display_name, username, email`,
            [displayName, username, email, hashedPassword, verificationToken, verificationExpires]
        );

        const verificationLink = `${process.env.FRONTEND_URL}/index.html?verifyToken=${verificationToken}`;

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        await transporter.sendMail({
            from: `"RIAD Training System" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: "Verify your RIAD Training account",
            text: `Verify your account here: ${verificationLink}`,
            html: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;">
    
    <h2 style="color:#111;">Verify your email</h2>

    <p>
        Welcome to <strong>RIAD Training System</strong>.
        Click the button below to activate your account.
    </p>

    <p style="margin:30px 0;">
        <a href="${verificationLink}"
           style="
                background:#f05a28;
                color:#ffffff;
                padding:14px 28px;
                text-decoration:none;
                border-radius:8px;
                font-weight:bold;
                display:inline-block;
           ">
            Verify Email
        </a>
    </p>

    <p style="color:#666;">
        This verification link expires in 24 hours.
    </p>

    <hr style="margin:30px 0;border:none;border-top:1px solid #ddd;">

    <p style="font-size:12px;color:#888;">
        If the button doesn't work, copy and paste this link into your browser:
    </p>

    <p style="font-size:12px;word-break:break-all;">
        ${verificationLink}
    </p>

</div>
`,
        });
        res.status(201).json({
            message: "Account created. Please check your email to verify your account (if you don't see it, check your spam folder).",
            user: result.rows[0],
        });
    } catch (error) {
        console.error("SIGNUP ERROR:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                message: "Username already exists."
            });
        }

        res.status(500).json({
            message: "Server error."
        });
    }
});

app.post("/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        const result = await pool.query(
            `SELECT * FROM users
   WHERE LOWER(username) = LOWER($1)
   OR LOWER(email) = LOWER($1)`,
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ message: "Invalid username or password." });
        }

        const user = result.rows[0];
        if (!user.email_verified) {
            return res.status(403).json({
                message: "Please verify your email before logging in."
            });
        }
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ message: "Invalid username or password." });
        }

        const token = jwt.sign(
            {
                id: user.id,
                username: user.username,
            },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({
            message: "Login successful",
            token,
            user: {
                id: user.id,
                display_name: user.display_name,
                username: user.username,
            },
        });
    } catch (error) {
        res.status(500).json({ message: "Server error." });
    }
});
app.post("/programs", authenticateToken, async (req, res) => {
    try {
        const { program } = req.body;
        const userId = req.user.id;

        await pool.query(
            `INSERT INTO programs (user_id, program_data)
       VALUES ($1, $2)`,
            [userId, JSON.stringify(program)]
        );

        res.json({ message: "Program saved" });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
});

app.get("/programs/:username", async (req, res) => {
    try {
        const { username } = req.params;

        const userResult = await pool.query(
            "SELECT id FROM users WHERE username = $1",
            [username]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        const userId = userResult.rows[0].id;

        const programs = await pool.query(
            `SELECT id, program_data, created_at
FROM programs
WHERE user_id = $1
ORDER BY created_at DESC`,
            [userId]
        );

        res.json(programs.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
});

app.post("/avatar", async (req, res) => {
    try {
        const { username, avatar } = req.body;

        await pool.query(
            "UPDATE users SET avatar = $1 WHERE username = $2",
            [avatar, username]
        );

        res.json({ message: "Avatar saved" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
});


app.get("/user/:username", async (req, res) => {
    try {
        const { username } = req.params;

        const result = await pool.query(
            `SELECT id, display_name, username, email, avatar
       FROM users
       WHERE username = $1`,
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
});

app.put("/profile", authenticateToken, async (req, res) => {
    try {
        const { displayName, email, currentPassword, newPassword } = req.body;
        const userId = req.user.id;

        const userResult = await pool.query(
            "SELECT * FROM users WHERE id = $1",
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: "User not found." });
        }

        const user = userResult.rows[0];

        let passwordToSave = user.password;

        if (newPassword) {
            if (!currentPassword) {
                return res.status(400).json({ message: "Current password is required." });
            }

            const isMatch = await bcrypt.compare(currentPassword, user.password);

            if (!isMatch) {
                return res.status(401).json({ message: "Current password is incorrect." });
            }

            if (newPassword.length < 6) {
                return res.status(400).json({ message: "New password must be at least 6 characters." });
            }

            passwordToSave = await bcrypt.hash(newPassword, 10);
        }

        await pool.query(
            `UPDATE users
       SET display_name = $1,
           email = $2,
           password = $3
       WHERE id = $4`,
            [displayName, email, passwordToSave, userId]
        );

        res.json({ message: "Profile updated successfully." });

    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({ message: "Email already exists." });
        }

        console.error(error);
        res.status(500).json({ message: "Server error." });
    }
});

app.delete("/programs/:id", async (req, res) => {
    try {
        const { id } = req.params;

        await pool.query(
            "DELETE FROM programs WHERE id = $1",
            [id]
        );

        res.json({ message: "Program deleted" });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
    }
});

app.post("/forgot-password", async (req, res) => {
    try {
        const { email } = req.body;

        const userResult = await pool.query(
            "SELECT * FROM users WHERE email = $1",
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.json({ message: "If this email exists, a reset link has been sent. Check your inbox and spam." });
        }

        const token = crypto.randomBytes(32).toString("hex");
        const expires = new Date(Date.now() + 1000 * 60 * 30);

        await pool.query(
            `UPDATE users
       SET reset_token = $1, reset_token_expires = $2
       WHERE email = $3`,
            [token, expires, email]
        );

        const resetLink = `${process.env.FRONTEND_URL}/index.html?resetToken=${token}`;

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });


        console.log("Sending reset email to:", email);
        console.log("Using email user:", process.env.EMAIL_USER);
        console.log("About to send email...");
        const info = await transporter.sendMail({
            from: `"RIAD Training System" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: "Reset your RIAD Training password",
            text: `Reset your password here: ${resetLink}`,
            html: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;">

    <h2 style="color:#111;">Reset your password</h2>

    <p>
        We received a request to reset your
        <strong>RIAD Training System</strong> password.
    </p>

    <p style="margin:30px 0;">
        <a href="${resetLink}"
           style="
                background:#f05a28;
                color:#ffffff;
                padding:14px 28px;
                text-decoration:none;
                border-radius:8px;
                font-weight:bold;
                display:inline-block;
           ">
            Reset Password
        </a>
    </p>

    <p style="color:#666;">
        This link expires in 30 minutes.
    </p>

    <hr style="margin:30px 0;border:none;border-top:1px solid #ddd;">

    <p style="font-size:12px;color:#888;">
        If the button doesn't work, copy and paste this link into your browser:
    </p>

    <p style="font-size:12px;word-break:break-all;">
        ${resetLink}
    </p>

</div>
`,
        });

        console.log("Email sent successfully!");
        console.log("Accepted:", info.accepted);
        console.log("Rejected:", info.rejected);
        console.log("Response:", info.response);
        console.log("Message ID:", info.messageId);
        res.json({ message: "If this email exists, a reset link has been sent." });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error." });
    }
});

app.post("/reset-password", async (req, res) => {
    try {
        const { token, password } = req.body;

        const userResult = await pool.query(
            `SELECT * FROM users
       WHERE reset_token = $1
       AND reset_token_expires > NOW()`,
            [token]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({ message: "Invalid or expired reset link." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await pool.query(
            `UPDATE users
       SET password = $1,
           reset_token = NULL,
           reset_token_expires = NULL
       WHERE id = $2`,
            [hashedPassword, userResult.rows[0].id]
        );

        res.json({ message: "Password reset successful." });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error." });
    }
});

app.get("/me", authenticateToken, async (req, res) => {
    try {

        const result = await pool.query(
            `SELECT id,
              display_name,
              username,
              email,
              avatar
       FROM users
       WHERE id = $1`,
            [req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "User not found"
            });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Server error"
        });
    }
});

app.get("/verify-email/:token", async (req, res) => {
    try {
        const { token } = req.params;

        const userResult = await pool.query(
            `SELECT * FROM users
       WHERE email_verification_token = $1
       AND email_verification_expires > NOW()`,
            [token]
        );

        if (userResult.rows.length === 0) {
            return res.status(400).json({
                message: "Invalid or expired verification link."
            });
        }

        await pool.query(
            `UPDATE users
       SET email_verified = TRUE,
           email_verification_token = NULL,
           email_verification_expires = NULL
       WHERE id = $1`,
            [userResult.rows[0].id]
        );

        res.json({
            message: "Email verified successfully. You can now log in."
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Server error."
        });
    }
});

app.post("/admin/send-update-email", async (req, res) => {
    try {
        const { secret, subject, message } = req.body;

        if (secret !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ message: "Not authorized." });
        }

        const usersResult = await pool.query(
            "SELECT email, display_name FROM users WHERE email_verified = TRUE"
        );

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        for (const user of usersResult.rows) {
            await transporter.sendMail({
                from: `"RIAD Training System" <${process.env.EMAIL_USER}>`,
                to: user.email,
                subject: subject,
                html: `
                    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:20px;">
                        <h2>${subject}</h2>
                        <p>Hi ${user.display_name || "there"},</p>
                        <p>${message}</p>
                        <p style="margin-top:25px;">
                            Thank you for using <strong>RIAD Training System</strong>.
                            <a href="riad-training-system.vercel.app" target="_blank" rel="noopener noreferrer">Click here to visit the site</a>.
                        </p>
                    </div>
                `
            });
        }

        res.json({
            message: `Update email sent to ${usersResult.rows.length} verified users.`
        });

    } catch (error) {
        console.error("ADMIN EMAIL ERROR:", error);
        res.status(500).json({ message: "Server error." });
    }
});
app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});