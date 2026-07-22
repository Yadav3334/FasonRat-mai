import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { useThemeStore } from '@/store/theme';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Eye, EyeOff, Shield, Sun, Moon, Monitor } from 'lucide-react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLockedOut, setIsLockedOut] = useState(false);
  const { login, isLoading, error, clearError } = useAuthStore();
  const { resolvedTheme, setTheme, theme } = useThemeStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setIsLockedOut(false);
    const success = await login(username, password);
    if (success) {
      navigate('/');
    } else {
      const storeError = useAuthStore.getState().error;
      if (storeError?.includes('Too many') || storeError?.includes('locked') || storeError?.includes('429')) {
        setIsLockedOut(true);
      }
    }
  };

  const cycleTheme = () => {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
  };

  const ThemeIcon = resolvedTheme === 'dark' ? Moon : Sun;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/30 p-4">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-primary/5 rounded-full blur-3xl" />
      </div>

      <button
        onClick={cycleTheme}
        className="absolute top-4 right-4 z-10 inline-flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-background/80 backdrop-blur-sm text-foreground hover:bg-accent transition-colors"
        aria-label="Toggle theme"
        title={theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}
      >
        {theme === 'system' ? <Monitor className="h-4 w-4" /> : <ThemeIcon className="h-4 w-4" />}
      </button>

      <Card className="w-full max-w-[400px] shadow-xl border-0 bg-card/80 backdrop-blur-sm relative">
        <CardHeader className="text-center space-y-4 pb-4">
          <div>
            <CardTitle className="text-xl">Sign In</CardTitle>
            <CardDescription className="mt-1">Sign in to your control panel</CardDescription>
          </div>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {error && (
              <div className={`p-3 rounded-lg border text-sm flex items-center gap-2 ${isLockedOut ? 'bg-orange-500/10 border-orange-500/20 text-orange-600' : 'bg-destructive/10 border-destructive/20 text-destructive'}`}>
                <Shield className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="username">Username or Email</Label>
              <Input
                id="username"
                type="text"
                placeholder="Enter username or email"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
                disabled={isLockedOut}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="pr-10"
                  disabled={isLockedOut}
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={isLoading || isLockedOut}>
              {isLoading ? 'Signing in...' : isLockedOut ? 'Locked Out — Try Again Later' : 'Sign In'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
