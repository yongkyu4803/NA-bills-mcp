export const metadata = {
  title: '국회 법안 MCP 서버',
  description: '제22대 국회 발의 법안 데이터를 MCP 도구로 제공합니다.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '3rem auto', padding: '0 1.25rem', lineHeight: 1.7 }}>
        {children}
      </body>
    </html>
  );
}
