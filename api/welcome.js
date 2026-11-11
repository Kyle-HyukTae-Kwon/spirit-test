// 처음 가입한 회원에게 환영 메일을 한 번만 보내는 Vercel 함수
//
// 브라우저는 로그인 토큰(Authorization: Bearer <access_token>)만 보낸다.
// 서버는 그 토큰으로 Supabase에 "이 사람 누구야?"를 물어 회원을 확인하고,
// profiles.welcome_sent_at 이 비어 있을 때만 메일을 보낸다.
//
// 필요한 환경 변수 (Vercel → Project → Settings → Environment Variables)
//   SUPABASE_URL              예: https://xxxx.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  sb_publishable_...
//   RESEND_API_KEY            re_...
// 키는 여기서만 읽고, 코드나 config.js 에는 쓰지 않는다.

const FROM = "캠퍼스 정령 테스트 <onboarding@resend.dev>";
const SUBJECT = "정령 테스트 가입을 환영합니다!";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, RESEND_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !RESEND_API_KEY) {
    console.error("welcome: 환경 변수가 비어 있음");
    return res.status(500).json({ error: "server_not_configured" });
  }

  // 1. 토큰 꺼내기
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return res.status(401).json({ error: "no_token" });

  // 사용자 토큰으로 Supabase를 부른다 → RLS가 "자기 것만" 지켜 준다
  const sbHeaders = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };

  try {
    // 2. 토큰으로 회원 확인 (가짜·만료 토큰이면 여기서 막힌다)
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: sbHeaders });
    if (!userRes.ok) return res.status(401).json({ error: "invalid_token" });
    const user = await userRes.json();
    if (!user.email) return res.status(400).json({ error: "no_email" });

    // 3. "아직 안 보냄"인 줄만 골라 보낸 시각을 먼저 찍는다 (한 번만 보내기)
    //    동시에 두 번 불려도 한쪽만 줄을 바꾸는 데 성공한다.
    const sentAt = new Date().toISOString();
    const claimRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&welcome_sent_at=is.null&select=nickname`,
      {
        method: "PATCH",
        headers: { ...sbHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ welcome_sent_at: sentAt })
      }
    );
    if (!claimRes.ok) {
      console.error("welcome: profiles 갱신 실패", claimRes.status, await claimRes.text());
      return res.status(502).json({ error: "profile_update_failed" });
    }
    const claimed = await claimRes.json();
    if (claimed.length === 0) {
      // 이미 보냈거나, 아직 profiles 줄이 없음
      return res.status(200).json({ sent: false, reason: "already_sent_or_no_profile" });
    }

    // 4. Resend로 메일 보내기
    const nickname = claimed[0].nickname || "정령 친구";
    const mailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        // 혹시 다시 불려도 Resend가 같은 메일을 두 번 보내지 않게
        "Idempotency-Key": `welcome-${user.id}`
      },
      body: JSON.stringify({
        from: FROM,
        to: [user.email],
        subject: SUBJECT,
        text: mailText(nickname),
        html: mailHtml(nickname)
      })
    });

    if (!mailRes.ok) {
      console.error("welcome: Resend 실패", mailRes.status, await mailRes.text());
      // 못 보냈으니 표시를 되돌려서 다음 로그인 때 다시 시도하게 한다
      await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&welcome_sent_at=eq.${encodeURIComponent(sentAt)}`,
        { method: "PATCH", headers: sbHeaders, body: JSON.stringify({ welcome_sent_at: null }) }
      ).catch(() => {});
      return res.status(502).json({ error: "mail_failed" });
    }

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error("welcome: 예외", err);
    return res.status(500).json({ error: "unexpected" });
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function mailText(nickname) {
  return [
    `${nickname}님, 캠퍼스 정령 테스트에 오신 걸 환영해요! 🌱`,
    "",
    "이제 테스트 결과가 '내 정령 도감'에 차곡차곡 모여요.",
    "갓생이, 친친이, 열정이, 감성이 — 네 정령을 모두 만나 보세요.",
    "",
    "재미로 보는 테스트예요. 우리는 모두 여러 정령의 모습을 조금씩 갖고 있어요."
  ].join("\n");
}

function mailHtml(nickname) {
  const name = escapeHtml(nickname);
  return `<!doctype html>
<html lang="ko"><body style="margin:0;padding:24px;background:#f6f3ee;font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#2b2a28;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e0d8;border-radius:20px;padding:32px 24px;text-align:center;">
    <div style="font-size:48px;">🌱</div>
    <h1 style="font-size:22px;margin:12px 0;">${name}님, 환영해요!</h1>
    <p style="line-height:1.7;margin:0 0 16px;">이제 테스트 결과가 <strong>내 정령 도감</strong>에 차곡차곡 모여요.<br>
    📋 갓생이 · 🤝 친친이 · 🔥 열정이 · 🎨 감성이<br>네 정령을 모두 만나 보세요.</p>
    <p style="font-size:13px;color:#6f6a63;margin:0;">재미로 보는 테스트예요.<br>우리는 모두 여러 정령의 모습을 조금씩 갖고 있어요.</p>
  </div>
</body></html>`;
}
