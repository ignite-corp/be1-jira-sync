'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Users, ChevronsUpDown, Check, Settings, Loader2 } from 'lucide-react';
import { useCurrentUser, type AppUser } from '@/contexts/user-context';
import { cn } from '@/lib/utils';

export default function SelectUserPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isSwitchMode = searchParams.get('switch') === 'true';
  const { currentUser, setCurrentUser } = useCurrentUser();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(
    isSwitchMode && currentUser ? currentUser.id : ''
  );

  // 이미 사용자가 선택되어 있고 변경 모드가 아니면 홈으로 이동
  useEffect(() => {
    if (currentUser && !isSwitchMode) {
      router.replace('/');
    }
  }, [currentUser, isSwitchMode, router]);

  useEffect(() => {
    fetch('/api/users')
      .then((res) => res.json())
      .then((json) => {
        if (json.success) {
          setUsers(json.data);
        } else {
          setError(json.error || '사용자 목록을 불러올 수 없습니다.');
        }
      })
      .catch(() => setError('서버에 연결할 수 없습니다.'))
      .finally(() => setLoading(false));
  }, []);

  const selectedUserObj = users.find((u) => u.id === selectedId);

  const isCredentialsComplete = (user: AppUser) => {
    return user.hasIgniteCredentials && user.hasHmgCredentials;
  };

  const handleConfirm = () => {
    if (selectedUserObj) {
      setCurrentUser(selectedUserObj);
      if (isCredentialsComplete(selectedUserObj)) {
        router.push('/');
      } else {
        router.push(`/settings/users?setup=${selectedUserObj.id}`);
      }
    }
  };

  if (currentUser && !isSwitchMode) return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-md space-y-4">
        <Card>
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Users className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl">사용자 선택</CardTitle>
            <CardDescription>
              작업할 사용자를 선택하세요. 선택한 사용자의 Jira 인증 정보로
              동기화가 실행됩니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="text-center py-8 space-y-3">
                <p className="text-sm text-destructive">{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.location.reload()}
                >
                  다시 시도
                </Button>
              </div>
            ) : users.length === 0 ? (
              <div className="text-center py-8 space-y-3">
                <p className="text-sm text-muted-foreground">
                  등록된 사용자가 없습니다.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push('/settings/users')}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  사용자 관리
                </Button>
              </div>
            ) : (
              <>
                <Popover open={open} onOpenChange={setOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={open}
                      className="w-full justify-between h-11"
                    >
                      {selectedUserObj ? (
                        <span className="flex items-center gap-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-xs font-semibold shrink-0">
                            {selectedUserObj.name.charAt(0)}
                          </span>
                          <span>{selectedUserObj.name}</span>
                          {selectedUserObj.teamName && (
                            <span className="text-xs text-muted-foreground">
                              ({selectedUserObj.teamName})
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          사용자를 검색하거나 선택하세요
                        </span>
                      )}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="이름으로 검색..." />
                      <CommandList>
                        <CommandEmpty>검색 결과가 없습니다.</CommandEmpty>
                        <CommandGroup>
                          {users.map((user) => (
                            <CommandItem
                              key={user.id}
                              value={user.name}
                              onSelect={() => {
                                setSelectedId(
                                  user.id === selectedId ? '' : user.id
                                );
                                setOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  'mr-2 h-4 w-4',
                                  selectedId === user.id
                                    ? 'opacity-100'
                                    : 'opacity-0'
                                )}
                              />
                              <span className="flex items-center gap-2">
                                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-xs font-semibold shrink-0">
                                  {user.name.charAt(0)}
                                </span>
                                <span>{user.name}</span>
                                {user.teamName && (
                                  <span className="text-xs text-muted-foreground">
                                    {user.teamName}
                                  </span>
                                )}
                              </span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>

                <Button
                  className="w-full"
                  disabled={!selectedId}
                  onClick={handleConfirm}
                >
                  시작하기
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <div className="text-center">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => router.push('/settings')}
          >
            <Settings className="mr-1 h-3 w-3" />
            설정
          </Button>
        </div>
      </div>
    </div>
  );
}
