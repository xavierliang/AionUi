import { ipcBridge } from '@/common';
import { transformMessage } from '@/common/chatLib';
import type { IProvider, TProviderWithModel } from '@/common/storage';
import { ConfigStorage } from '@/common/storage';
import { uuid } from '@/common/utils';
import SendBox from '@/renderer/components/sendbox';
import ThoughtDisplay, { type ThoughtData } from '@/renderer/components/ThoughtDisplay';
import { geminiModeList } from '@/renderer/hooks/useModeModeList';
import { getSendBoxDraftHook } from '@/renderer/hooks/useSendBoxDraft';
import { createSetUploadFile, useSendBoxFiles } from '@/renderer/hooks/useSendBoxFiles';
import { useAddOrUpdateMessage } from '@/renderer/messages/hooks';
import { allSupportedExts, getCleanFileName } from '@/renderer/services/FileService';
import { emitter, useAddEventListener } from '@/renderer/utils/emitter';
import { hasSpecificModelCapability } from '@/renderer/utils/modelCapabilities';
import { Button, Dropdown, Menu, Tag } from '@arco-design/web-react';
import { Plus } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

const useGeminiSendBoxDraft = getSendBoxDraftHook('gemini', {
  _type: 'gemini',
  atPath: [],
  content: '',
  uploadFile: [],
});

const useGeminiMessage = (conversation_id: string) => {
  const addOrUpdateMessage = useAddOrUpdateMessage();
  const [running, setRunning] = useState(false);
  const [thought, setThought] = useState<ThoughtData>({
    description: '',
    subject: '',
  });

  useEffect(() => {
    return ipcBridge.geminiConversation.responseStream.on((message) => {
      if (conversation_id !== message.conversation_id) {
        return;
      }
      // console.log('responseStream.message', message);
      switch (message.type) {
        case 'thought':
          setThought(message.data);
          break;
        case 'start':
          setRunning(true);
          break;
        case 'finish':
          {
            setRunning(false);
            setThought({ subject: '', description: '' });
          }
          break;
        default:
          {
            // Backend handles persistence, Frontend only updates UI
            addOrUpdateMessage(transformMessage(message));
          }
          break;
      }
    });
  }, [conversation_id, addOrUpdateMessage]);

  useEffect(() => {
    setRunning(false);
    setThought({ subject: '', description: '' });
    void ipcBridge.conversation.get.invoke({ id: conversation_id }).then((res) => {
      if (!res) return;
      if (res.status === 'running') {
        setRunning(true);
      }
    });
  }, [conversation_id]);

  return { thought, setThought, running };
};

const EMPTY_ARRAY: string[] = [];

const useSendBoxDraft = (conversation_id: string) => {
  const { data, mutate } = useGeminiSendBoxDraft(conversation_id);

  const atPath = data?.atPath ?? EMPTY_ARRAY;
  const uploadFile = data?.uploadFile ?? EMPTY_ARRAY;
  const content = data?.content ?? '';

  const setAtPath = useCallback(
    (atPath: string[]) => {
      mutate((prev) => ({ ...prev, atPath }));
    },
    [data, mutate]
  );

  const setUploadFile = createSetUploadFile(mutate, data);

  const setContent = useCallback(
    (content: string) => {
      mutate((prev) => ({ ...prev, content }));
    },
    [data, mutate]
  );

  return {
    atPath,
    uploadFile,
    setAtPath,
    setUploadFile,
    content,
    setContent,
  };
};

const GeminiSendBox: React.FC<{
  conversation_id: string;
  model: TProviderWithModel;
}> = ({ conversation_id, model }) => {
  const { t } = useTranslation();
  const { thought, running } = useGeminiMessage(conversation_id);

  const { atPath, uploadFile, setAtPath, setUploadFile, content, setContent } = useSendBoxDraft(conversation_id);

  const addOrUpdateMessage = useAddOrUpdateMessage();

  // Current model state (initialized from props)
  const [currentModel, setCurrentModel] = useState<TProviderWithModel | undefined>(model);
  useEffect(() => {
    setCurrentModel(model);
  }, [model?.id, model?.useModel]);

  // Model list for dropdown (providers + models), with optional Google Auth Gemini provider
  const { data: geminiConfig } = useSWR('gemini.config', () => ConfigStorage.get('gemini.config'));
  const { data: isGoogleAuth } = useSWR('google.auth.status' + (geminiConfig?.proxy || ''), () => ipcBridge.googleAuth.status.invoke({ proxy: geminiConfig?.proxy }).then((d) => d.success));
  const { data: modelConfig } = useSWR('model.config.sendbox', () => ipcBridge.mode.getModelConfig.invoke());

  const availableModelsCache = useMemo(() => new Map<string, string[]>(), []);
  const getAvailableModels = useCallback(
    (provider: IProvider): string[] => {
      const cacheKey = `${provider.id}-${(provider.model || []).join(',')}`;
      if (availableModelsCache.has(cacheKey)) return availableModelsCache.get(cacheKey)!;
      const result: string[] = [];
      for (const modelName of provider.model || []) {
        const functionCalling = hasSpecificModelCapability(provider, modelName, 'function_calling');
        const excluded = hasSpecificModelCapability(provider, modelName, 'excludeFromPrimary');
        if ((functionCalling === true || functionCalling === undefined) && excluded !== true) {
          result.push(modelName);
        }
      }
      availableModelsCache.set(cacheKey, result);
      return result;
    },
    [availableModelsCache]
  );

  const providers = useMemo(() => {
    let list: IProvider[] = Array.isArray(modelConfig) ? modelConfig : [];
    if (isGoogleAuth) {
      const googleProvider: IProvider = {
        id: 'google-auth-gemini',
        name: 'Gemini Google Auth',
        platform: 'gemini-with-google-auth',
        baseUrl: '',
        apiKey: '',
        model: geminiModeList.map((v) => v.value),
        capabilities: [{ type: 'text' }, { type: 'vision' }, { type: 'function_calling' }],
      } as unknown as IProvider;
      list = [googleProvider, ...list];
    }
    // Filter providers with at least one primary chat model
    return list.filter((p) => getAvailableModels(p).length > 0);
  }, [isGoogleAuth, modelConfig, getAvailableModels]);

  const handleSelectModel = useCallback(
    async (provider: IProvider, modelName: string) => {
      const selected: TProviderWithModel = { ...(provider as unknown as TProviderWithModel), useModel: modelName };
      // Update conversation model and restart backend task
      const ok = await ipcBridge.conversation.update.invoke({ id: conversation_id, updates: { model: selected } });
      if (ok) {
        setCurrentModel(selected);
      }
    },
    [conversation_id]
  );

  // 使用共享的文件处理逻辑
  const { handleFilesAdded, processMessageWithFiles, clearFiles } = useSendBoxFiles({
    atPath,
    uploadFile,
    setAtPath,
    setUploadFile,
  });

  const onSendHandler = async (message: string) => {
    if (!currentModel?.useModel) return;
    const msg_id = uuid();
    message = processMessageWithFiles(message);
    // User message: Display in UI immediately (Backend will persist when receiving from IPC)
    addOrUpdateMessage(
      {
        id: msg_id,
        type: 'text',
        position: 'right',
        conversation_id,
        content: {
          content: message,
        },
        createdAt: Date.now(),
      },
      true
    );
    await ipcBridge.geminiConversation.sendMessage.invoke({
      input: message,
      msg_id,
      conversation_id,
      files: uploadFile,
    });
    emitter.emit('gemini.selected.file.clear');
    if (uploadFile.length) {
      emitter.emit('gemini.workspace.refresh');
    }
    clearFiles();
  };

  useAddEventListener('gemini.selected.file', setAtPath);

  return (
    <div className='max-w-800px w-full  mx-auto flex flex-col'>
      <ThoughtDisplay thought={thought} />

      <SendBox
        value={content}
        onChange={setContent}
        loading={running}
        disabled={!currentModel?.useModel}
        placeholder={currentModel?.useModel ? '' : t('conversation.chat.noModelSelected')}
        onStop={() => {
          return ipcBridge.conversation.stop.invoke({ conversation_id }).then(() => {
            console.log('stopStream');
          });
        }}
        className='z-10'
        onFilesAdded={handleFilesAdded}
        supportedExts={allSupportedExts}
        tools={
          <>
            <Button
              type='secondary'
              shape='circle'
              className='sendbox-icon-btn sendbox-icon-plus'
              icon={<Plus theme='outline' size='14' strokeWidth={2} fill='#333' />}
              onClick={() => {
                void ipcBridge.dialog.showOpen
                  .invoke({
                    properties: ['openFile', 'multiSelections'],
                  })
                  .then((files) => {
                    if (files && files.length > 0) {
                      setUploadFile((prev) => [...prev, ...files]);
                    }
                  });
              }}
            ></Button>
            <Dropdown
              trigger='click'
              droplist={
                <Menu>
                  {(providers || []).map((provider) => {
                    const models = getAvailableModels(provider);
                    return (
                      <Menu.ItemGroup title={provider.name} key={provider.id}>
                        {models.map((modelName) => (
                          <Menu.Item
                            key={`${provider.id}-${modelName}`}
                            onClick={() => {
                              void handleSelectModel(provider, modelName);
                            }}
                          >
                            {modelName}
                          </Menu.Item>
                        ))}
                      </Menu.ItemGroup>
                    );
                  })}
                </Menu>
              }
            >
              <Button className={'ml-4px sendbox-model-btn'} shape='round'>
                {currentModel ? currentModel.useModel : t('conversation.welcome.selectModel')}
              </Button>
            </Dropdown>
          </>
        }
        prefix={
          <>
            {uploadFile.map((path) => {
              return (
                <Tag
                  color='blue'
                  key={path}
                  closable
                  className={'mr-4px'}
                  onClose={() => {
                    setUploadFile(uploadFile.filter((v) => v !== path));
                  }}
                >
                  {getCleanFileName(path)}
                </Tag>
              );
            })}
            {atPath.map((path) => (
              <Tag
                key={path}
                color='gray'
                closable
                className={'mr-4px'}
                onClose={() => {
                  const newAtPath = atPath.filter((v) => v !== path);
                  emitter.emit('gemini.selected.file', newAtPath);
                  setAtPath(newAtPath);
                }}
              >
                {path}
              </Tag>
            ))}
          </>
        }
        onSend={onSendHandler}
      ></SendBox>
    </div>
  );
};

export default GeminiSendBox;
