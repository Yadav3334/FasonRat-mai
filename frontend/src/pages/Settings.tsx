import { useState, useEffect } from 'react';
import { authApi } from '@/services/api';
import { useAuthStore } from '@/store/auth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Save, AlertCircle, CheckCircle, User, Lock, ShieldCheck, Shield } from 'lucide-react';

export default function SettingsPage() {
  const { user, checkAuth } = useAuthStore();

  const [profileUsername, setProfileUsername] = useState(user?.username || '');
  const [profileEmail, setProfileEmail] = useState(user?.email || '');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  useEffect(() => {
    if (user) {
      setProfileUsername(user.username);
      setProfileEmail(user.email || '');
    }
  }, [user]);

  const handleProfileSave = async () => {
    setProfileSaving(true);
    setProfileError(null);
    setProfileSuccess(false);
    try {
      const updates: { username?: string; email?: string } = {};
      if (profileUsername !== user?.username) updates.username = profileUsername;
      if (profileEmail !== user?.email) updates.email = profileEmail;
      if (Object.keys(updates).length > 0) {
        const res = await authApi.updateProfile(updates);
        if (res.data.success) {
          await checkAuth();
          setProfileSuccess(true);
          setTimeout(() => setProfileSuccess(false), 3000);
        } else {
          setProfileError(res.data.error || 'Failed to update profile');
        }
      }
    } catch (err: any) {
      setProfileError(err?.response?.data?.error || 'Failed to update profile');
    }
    setProfileSaving(false);
  };

  const handlePasswordChange = async () => {
    if (newPassword !== confirmNewPassword) {
      setPasswordError('Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('Password must be at least 6 characters');
      return;
    }
    setPasswordSaving(true);
    setPasswordError(null);
    setPasswordSuccess(false);
    try {
      const res = await authApi.changePassword(currentPassword, newPassword);
      if (res.data.success) {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmNewPassword('');
        setPasswordSuccess(true);
        setTimeout(() => setPasswordSuccess(false), 3000);
      } else {
        setPasswordError(res.data.error || 'Failed to change password');
      }
    } catch (err: any) {
      setPasswordError(err?.response?.data?.error || 'Failed to change password');
    }
    setPasswordSaving(false);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">Manage your account information</p>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <User className="h-5 w-5" /> Profile
          </CardTitle>
          <CardDescription>Update your account information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {profileError && (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" /> {profileError}
            </div>
          )}
          {profileSuccess && (
            <div className="p-3 rounded-lg bg-success/10 border border-success/20 text-success text-sm flex items-center gap-2">
              <CheckCircle className="h-4 w-4 shrink-0" /> Profile updated successfully
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="profile-username">Username</Label>
              <Input
                id="profile-username"
                type="text"
                value={profileUsername}
                onChange={(e) => setProfileUsername(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-email">Email</Label>
              <Input
                id="profile-email"
                type="email"
                value={profileEmail}
                onChange={(e) => setProfileEmail(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={user?.role === 'admin' ? 'default' : 'secondary'} className="gap-1">
              {user?.role === 'admin' ? <ShieldCheck className="h-3 w-3" /> : <Shield className="h-3 w-3" />}
              {user?.role === 'admin' ? 'Administrator' : 'User'}
            </Badge>
          </div>
          <Button onClick={handleProfileSave} disabled={profileSaving} className="gap-2">
            {profileSaving ? 'Saving...' : <><Save className="h-4 w-4" /> Save Profile</>}
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Lock className="h-5 w-5" /> Change Password
          </CardTitle>
          <CardDescription>Update your account password</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {passwordError && (
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" /> {passwordError}
            </div>
          )}
          {passwordSuccess && (
            <div className="p-3 rounded-lg bg-success/10 border border-success/20 text-success text-sm flex items-center gap-2">
              <CheckCircle className="h-4 w-4 shrink-0" /> Password changed successfully
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <Input
              id="current-password"
              type="password"
              placeholder="Enter current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type="password"
                placeholder="Enter new password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-new-password">Confirm New Password</Label>
              <Input
                id="confirm-new-password"
                type="password"
                placeholder="Confirm new password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
              />
            </div>
          </div>
          <Button onClick={handlePasswordChange} disabled={passwordSaving || !currentPassword || !newPassword || !confirmNewPassword} className="gap-2">
            {passwordSaving ? 'Changing...' : <><Lock className="h-4 w-4" /> Change Password</>}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
